"""
AP Workflow

Dapr workflow that executes an Activepieces flow by walking its linked-list
action chain. Receives a raw AP FlowVersion and walks it using the AP flow walker.

Reports progress back to AP via callback endpoints.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import dapr.ext.workflow as wf
import requests

from core.ap_flow_walker import walk_ap_flow

logger = logging.getLogger(__name__)


def ap_workflow(ctx: wf.DaprWorkflowContext, input_data: dict[str, Any]):
    """
    Dapr workflow that executes an AP flow.

    Input:
        flowRunId: str - AP flow run ID
        projectId: str - AP project ID
        platformId: str - AP platform ID
        flowVersion: dict - Full AP FlowVersion JSON (trigger + action chain)
        triggerPayload: Any - Trigger input data
        callbackUrl: str - URL to POST completion/progress updates
        executionType: str - BEGIN or RESUME
    """
    flow_run_id = input_data.get('flowRunId', ctx.instance_id)
    project_id = input_data.get('projectId', '')
    platform_id = input_data.get('platformId', '')
    flow_version = input_data.get('flowVersion', {})
    trigger_payload = input_data.get('triggerPayload')
    callback_url = input_data.get('callbackUrl', '')
    execution_type = input_data.get('executionType', 'BEGIN')

    logger.info(
        f"[APWorkflow] Starting AP flow: run={flow_run_id}, "
        f"flow={flow_version.get('displayName', 'unknown')}"
    )

    # Initialize step outputs with trigger data
    step_outputs: dict[str, Any] = {}
    trigger = flow_version.get('trigger', {})

    if trigger_payload is not None:
        trigger_name = trigger.get('name', 'trigger')
        step_outputs[trigger_name] = {
            'output': trigger_payload,
            'type': 'TRIGGER',
            'status': 'SUCCEEDED',
        }

    # Notify AP that execution has started
    if callback_url:
        _send_callback(callback_url, {
            'flowRunId': flow_run_id,
            'status': 'RUNNING',
        })

    start_time = time.time()

    try:
        # Walk the AP flow
        step_outputs = yield from _walk_flow_generator(
            ctx=ctx,
            trigger=trigger,
            step_outputs=step_outputs,
            flow_run_id=flow_run_id,
            callback_url=callback_url,
            project_id=project_id,
            platform_id=platform_id,
        )

        duration_ms = int((time.time() - start_time) * 1000)

        logger.info(
            f"[APWorkflow] Flow completed successfully: run={flow_run_id}, "
            f"steps={len(step_outputs)}, duration={duration_ms}ms"
        )

        # Send completion callback
        if callback_url:
            _send_callback(callback_url, {
                'flowRunId': flow_run_id,
                'status': 'SUCCEEDED',
                'steps': _format_step_outputs(step_outputs),
                'duration': duration_ms,
            })

        return {
            'status': 'SUCCEEDED',
            'steps': step_outputs,
            'duration': duration_ms,
        }

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        error_msg = str(e)

        logger.error(f"[APWorkflow] Flow failed: run={flow_run_id}, error={error_msg}")

        # Find the failed step
        failed_step = None
        for step_name, step_data in step_outputs.items():
            if isinstance(step_data, dict) and step_data.get('status') == 'FAILED':
                failed_step = {
                    'name': step_name,
                    'displayName': step_name,
                    'message': step_data.get('errorMessage', error_msg),
                }
                break

        # Send failure callback
        if callback_url:
            _send_callback(callback_url, {
                'flowRunId': flow_run_id,
                'status': 'FAILED',
                'steps': _format_step_outputs(step_outputs),
                'failedStep': failed_step or {
                    'name': 'unknown',
                    'displayName': 'Unknown',
                    'message': error_msg,
                },
                'duration': duration_ms,
            })

        return {
            'status': 'FAILED',
            'error': error_msg,
            'steps': step_outputs,
            'failedStep': failed_step,
            'duration': duration_ms,
        }


def _walk_flow_generator(
    ctx: wf.DaprWorkflowContext,
    trigger: dict[str, Any],
    step_outputs: dict[str, Any],
    flow_run_id: str,
    callback_url: str,
    project_id: str = '',
    platform_id: str = '',
):
    """
    Generator wrapper around walk_ap_flow for Dapr workflow compatibility.

    Dapr workflows use yield-based execution for durability, so we need to
    propagate yields from the flow walker up to the workflow runtime.
    """
    # Store trigger output
    trigger_name = trigger.get('name', 'trigger')
    if trigger_name not in step_outputs:
        step_outputs[trigger_name] = {
            'output': trigger.get('settings', {}).get('inputUiInfo', {}).get('currentSelectedData'),
            'type': 'TRIGGER',
            'status': 'SUCCEEDED',
        }

    # Walk the action chain
    current_action = trigger.get('nextAction')
    yield from _walk_action_chain_sync(
        ctx=ctx,
        action=current_action,
        step_outputs=step_outputs,
        flow_run_id=flow_run_id,
        callback_url=callback_url,
        project_id=project_id,
        platform_id=platform_id,
    )

    return step_outputs


def _walk_action_chain_sync(
    ctx: wf.DaprWorkflowContext,
    action: dict[str, Any] | None,
    step_outputs: dict[str, Any],
    flow_run_id: str,
    callback_url: str,
    connections: dict[str, Any] | None = None,
    project_id: str = '',
    platform_id: str = '',
):
    """
    Synchronous generator that walks an AP action chain.
    Uses yield for Dapr activity calls.
    """
    from core.ap_variable_resolver import resolve_ap_value
    from core.ap_condition_evaluator import evaluate_branches
    from activities.execute_action import execute_action

    current = action

    while current is not None:
        action_type = current.get('type')
        action_name = current.get('name', 'unknown')
        display_name = current.get('displayName', action_name)

        if current.get('skip', False):
            current = current.get('nextAction')
            continue

        logger.info(f"[APWalker] Executing step: {action_name} (type={action_type})")
        start_time = time.time()

        try:
            if action_type == 'PIECE':
                yield from _handle_piece_sync(ctx, current, step_outputs, execute_action, project_id, platform_id, flow_run_id, callback_url)
            elif action_type == 'CODE':
                yield from _handle_code_sync(ctx, current, step_outputs, execute_action)
            elif action_type == 'ROUTER':
                yield from _handle_router_sync(
                    ctx, current, step_outputs, flow_run_id, callback_url, connections, project_id, platform_id,
                )
            elif action_type == 'LOOP_ON_ITEMS':
                yield from _handle_loop_sync(
                    ctx, current, step_outputs, flow_run_id, callback_url, connections, project_id, platform_id,
                )
            else:
                logger.warning(f"[APWalker] Unknown action type: {action_type}")
                step_outputs[action_name] = {
                    'type': action_type,
                    'status': 'FAILED',
                    'errorMessage': f'Unknown action type: {action_type}',
                }

            duration_ms = int((time.time() - start_time) * 1000)
            if action_name in step_outputs:
                step_outputs[action_name]['duration'] = duration_ms

        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            step_outputs[action_name] = {
                'type': action_type,
                'status': 'FAILED',
                'errorMessage': str(e),
                'duration': duration_ms,
            }
            raise

        current = current.get('nextAction')


def _handle_piece_sync(ctx, action, step_outputs, execute_action, project_id='', platform_id='', flow_run_id='', callback_url=''):
    """Handle PIECE action using yield for Dapr activity call."""
    from datetime import datetime, timedelta
    from core.ap_variable_resolver import resolve_ap_value
    from core.ap_flow_walker import build_function_slug

    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    piece_name = settings.get('pieceName', '')
    ap_action_name = settings.get('actionName', '')
    input_data = settings.get('input', {})

    resolved_input = resolve_ap_value(input_data, step_outputs)
    slug = build_function_slug(piece_name, ap_action_name)

    # Extract connection ID from auth input
    connection_id = None
    if isinstance(resolved_input, dict):
        auth_input = resolved_input.get('auth')
        if isinstance(auth_input, str) and auth_input:
            connection_id = auth_input

    node = {
        'id': action_name,
        'data': {
            'type': 'action',
            'label': action.get('displayName', action_name),
            'config': {
                'actionType': slug,
                **({k: v for k, v in resolved_input.items() if k != 'auth'} if isinstance(resolved_input, dict) else {}),
            },
        },
    }

    activity_input = {
        'node': node,
        'nodeOutputs': step_outputs,
        'executionId': ctx.instance_id,
        'workflowId': 'ap-flow',
        'connectionExternalId': connection_id,
        'apProjectId': project_id,
        'apPlatformId': platform_id,
    }

    result = yield ctx.call_activity(
        activity=execute_action,
        input=activity_input,
    )

    # Check if the piece requested a pause (DELAY or WEBHOOK)
    # The pause field is forwarded by execute_action.py from fn-activepieces
    pause_data = result.get('pause')

    if pause_data and isinstance(pause_data, dict):
        pause_type = pause_data.get('type')

        if pause_type == 'DELAY':
            # Calculate delay from resumeDateTime
            resume_dt_str = pause_data.get('resumeDateTime', '')
            if resume_dt_str:
                try:
                    resume_dt = datetime.fromisoformat(resume_dt_str.replace('Z', '+00:00'))
                    now = datetime.now(resume_dt.tzinfo)
                    delay_seconds = max(0, (resume_dt - now).total_seconds())
                except (ValueError, TypeError):
                    delay_seconds = 0
            else:
                delay_seconds = 0

            logger.info(
                f"[APWalker] Piece {slug} requested DELAY pause: {delay_seconds}s"
            )

            step_outputs[action_name] = {
                'type': 'PIECE',
                'status': 'PAUSED',
                'input': resolved_input,
                'output': result.get('data'),
                'pauseMetadata': {'type': 'DELAY', 'resumeDateTime': resume_dt_str},
            }

            # Notify AP that the flow is paused (for run viewer)
            if callback_url:
                _send_callback(callback_url, {
                    'flowRunId': flow_run_id,
                    'status': 'PAUSED',
                    'pauseMetadata': {
                        'type': 'DELAY',
                        'resumeDateTime': resume_dt_str,
                    },
                    'steps': _format_step_outputs(step_outputs),
                })

            if delay_seconds > 0:
                yield ctx.create_timer(timedelta(seconds=delay_seconds))

            step_outputs[action_name]['status'] = 'SUCCEEDED'
            return

        elif pause_type == 'WEBHOOK':
            request_id = pause_data.get('requestId', f'pause-{action_name}-{ctx.instance_id}')

            logger.info(
                f"[APWalker] Piece {slug} requested WEBHOOK pause: requestId={request_id}"
            )

            step_outputs[action_name] = {
                'type': 'PIECE',
                'status': 'PAUSED',
                'input': resolved_input,
                'output': result.get('data'),
                'pauseMetadata': {
                    'type': 'WEBHOOK',
                    'requestId': request_id,
                    'response': pause_data.get('response'),
                },
            }

            # Notify AP that the flow is paused so it stores pauseMetadata on the flow_run.
            # Include the Dapr instance ID so AP can raise an external event on resume.
            if callback_url:
                _send_callback(callback_url, {
                    'flowRunId': flow_run_id,
                    'status': 'PAUSED',
                    'pauseMetadata': {
                        'type': 'WEBHOOK',
                        'requestId': request_id,
                        'response': pause_data.get('response', {}),
                        'daprInstanceId': ctx.instance_id,
                    },
                    'steps': _format_step_outputs(step_outputs),
                })

            # Wait for external event (resume callback)
            import dapr.ext.workflow as wf
            resume_event = ctx.wait_for_external_event(f'resume-{request_id}')
            # 24-hour timeout for webhook pauses
            timeout_timer = ctx.create_timer(timedelta(hours=24))
            completed = yield wf.when_any([resume_event, timeout_timer])

            if completed == timeout_timer:
                step_outputs[action_name]['status'] = 'FAILED'
                step_outputs[action_name]['errorMessage'] = 'Webhook pause timed out after 24 hours'
                raise RuntimeError(f"Piece {slug} webhook pause timed out")

            resume_data = resume_event.get_result()
            step_outputs[action_name]['status'] = 'SUCCEEDED'
            step_outputs[action_name]['output'] = resume_data
            return

    step_outputs[action_name] = {
        'type': 'PIECE',
        'status': 'SUCCEEDED' if result.get('success') else 'FAILED',
        'input': resolved_input,
        'output': result.get('data'),
        'errorMessage': result.get('error'),
    }

    if not result.get('success'):
        raise RuntimeError(f"Piece {slug} failed: {result.get('error')}")


def _handle_code_sync(ctx, action, step_outputs, execute_action):
    """Handle CODE action using yield for Dapr activity call."""
    from core.ap_variable_resolver import resolve_ap_value

    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    source_code = settings.get('sourceCode', {})
    input_data = settings.get('input', {})

    resolved_input = resolve_ap_value(input_data, step_outputs)

    node = {
        'id': action_name,
        'data': {
            'type': 'action',
            'label': action.get('displayName', action_name),
            'config': {
                'actionType': '_code/execute',
                'sourceCode': source_code,
                'input': resolved_input,
            },
        },
    }

    activity_input = {
        'node': node,
        'nodeOutputs': step_outputs,
        'executionId': ctx.instance_id,
        'workflowId': 'ap-flow',
    }

    result = yield ctx.call_activity(
        activity=execute_action,
        input=activity_input,
    )

    step_outputs[action_name] = {
        'type': 'CODE',
        'status': 'SUCCEEDED' if result.get('success') else 'FAILED',
        'input': resolved_input,
        'output': result.get('data'),
        'errorMessage': result.get('error'),
    }

    if not result.get('success'):
        raise RuntimeError(f"Code step {action_name} failed: {result.get('error')}")


def _handle_router_sync(ctx, action, step_outputs, flow_run_id, callback_url, connections, project_id='', platform_id=''):
    """Handle ROUTER action by evaluating conditions and recursing."""
    from core.ap_variable_resolver import resolve_ap_value
    from core.ap_condition_evaluator import evaluate_branches

    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    branches = settings.get('branches', [])
    children = action.get('children', [])
    execution_type = settings.get('executionType', 'EXECUTE_FIRST_MATCH')

    resolved_settings = resolve_ap_value(settings, step_outputs)
    resolved_branches = resolved_settings.get('branches', branches) if isinstance(resolved_settings, dict) else branches

    evaluations = evaluate_branches(resolved_branches, resolved_settings if isinstance(resolved_settings, dict) else {})

    step_outputs[action_name] = {
        'type': 'ROUTER',
        'status': 'SUCCEEDED',
        'input': settings,
        'output': {
            'branches': [
                {
                    'branchName': b.get('branchName', f'Branch {i+1}'),
                    'branchIndex': i + 1,
                    'evaluation': evaluations[i] if i < len(evaluations) else False,
                }
                for i, b in enumerate(branches)
            ],
        },
    }

    for i, should_execute in enumerate(evaluations):
        if not should_execute:
            continue
        if i < len(children) and children[i] is not None:
            yield from _walk_action_chain_sync(
                ctx=ctx,
                action=children[i],
                step_outputs=step_outputs,
                flow_run_id=flow_run_id,
                callback_url=callback_url,
                connections=connections,
                project_id=project_id,
                platform_id=platform_id,
            )
        if execution_type == 'EXECUTE_FIRST_MATCH':
            break


def _handle_loop_sync(ctx, action, step_outputs, flow_run_id, callback_url, connections, project_id='', platform_id=''):
    """Handle LOOP_ON_ITEMS action by iterating and recursing."""
    from core.ap_variable_resolver import resolve_ap_value

    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    items_expr = settings.get('items')
    first_loop_action = action.get('firstLoopAction')

    resolved_items = resolve_ap_value(items_expr, step_outputs)

    if not isinstance(resolved_items, list):
        step_outputs[action_name] = {
            'type': 'LOOP_ON_ITEMS',
            'status': 'FAILED',
            'errorMessage': 'The items you have selected must be a list.',
        }
        raise ValueError('Loop items must be a list')

    iterations = []

    for i, item in enumerate(resolved_items):
        step_outputs[action_name] = {
            'type': 'LOOP_ON_ITEMS',
            'status': 'SUCCEEDED',
            'output': {
                'current_item': item,
                'current_iteration': i + 1,
                'iterations': iterations,
            },
        }

        if first_loop_action is not None:
            yield from _walk_action_chain_sync(
                ctx=ctx,
                action=first_loop_action,
                step_outputs=step_outputs,
                flow_run_id=flow_run_id,
                callback_url=callback_url,
                connections=connections,
                project_id=project_id,
                platform_id=platform_id,
            )

        iterations.append({'index': i + 1, 'item': item})

    step_outputs[action_name] = {
        'type': 'LOOP_ON_ITEMS',
        'status': 'SUCCEEDED',
        'output': {
            'iterations': iterations,
            'item_count': len(resolved_items),
        },
    }


def _format_step_outputs(step_outputs: dict[str, Any]) -> dict[str, Any]:
    """Format step outputs for the AP callback (matching StepOutput format)."""
    formatted = {}
    for name, data in step_outputs.items():
        if isinstance(data, dict):
            formatted[name] = {
                'type': data.get('type', 'UNKNOWN'),
                'status': data.get('status', 'UNKNOWN'),
                'input': data.get('input'),
                'output': data.get('output'),
                'duration': data.get('duration', 0),
                'errorMessage': data.get('errorMessage'),
            }
        else:
            formatted[name] = data
    return formatted


def _send_callback(callback_url: str, payload: dict[str, Any]) -> None:
    """Send a callback to the AP server."""
    try:
        requests.post(
            callback_url,
            json=payload,
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"[APWorkflow] Failed to send callback: {e}")
