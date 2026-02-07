"""
AP Workflow — Dapr-Durable

Dapr workflow that executes an Activepieces flow by walking its linked-list
action chain. Every I/O operation (HTTP calls, credential fetches, timing)
goes through ctx.call_activity() so Dapr can replay the workflow
deterministically after restarts.

Dapr rules enforced:
  - NO time.time() or datetime.now() in the workflow function
  - NO requests.post() or any HTTP calls in the workflow function
  - NO imports of non-deterministic modules (time, datetime, requests)
  - All I/O through yield ctx.call_activity(...)
  - All waits through yield ctx.create_timer(...) or ctx.wait_for_external_event(...)
  - Pure dict operations and conditionals are OK (deterministic)
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

import dapr.ext.workflow as wf

logger = logging.getLogger(__name__)


# --- Utility functions (pure, deterministic — safe in workflow) ---

def normalize_piece_name(piece_name: str) -> str:
    """Strip the @activepieces/piece- prefix from an AP piece name."""
    if piece_name.startswith('@activepieces/piece-'):
        return piece_name[len('@activepieces/piece-'):]
    return piece_name


def extract_connection_id(auth_value: str | None) -> str | None:
    """
    Extract the connection ID from an AP auth template expression.

    AP stores connection references as: {{connections['<externalId>']}}
    The value inside the template IS the app_connection.externalId
    (confirmed: AP UI sets it from connection.externalId).
    We extract the literal ID from the template — the 'connections'
    namespace is AP-internal, not a step variable reference.
    """
    import re
    if not auth_value or not isinstance(auth_value, str):
        return None
    match = re.search(r"\{\{connections\['([^']+)'\]\}\}", auth_value)
    if match:
        return match.group(1)
    # Fallback: if it's a plain string (already resolved or literal ID)
    if not auth_value.startswith('{{'):
        return auth_value
    return None


def build_function_slug(piece_name: str, action_name: str) -> str:
    """Build a function-router slug from AP piece/action names."""
    normalized = normalize_piece_name(piece_name)
    return f"{normalized}/{action_name}"


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


# --- Main workflow function ---

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
    from activities.execute_action import execute_action
    from activities.send_ap_callback import send_ap_callback, send_ap_step_update

    flow_run_id = input_data.get('flowRunId', ctx.instance_id)
    project_id = input_data.get('projectId', '')
    platform_id = input_data.get('platformId', '')
    flow_version = input_data.get('flowVersion', {})
    trigger_payload = input_data.get('triggerPayload')
    callback_url = input_data.get('callbackUrl', '')

    logger.info(
        f"[APWorkflow] Starting AP flow: run={flow_run_id}, "
        f"flow={flow_version.get('displayName', 'unknown')}"
    )

    # Initialize step outputs with trigger data (deterministic)
    step_outputs: dict[str, Any] = {}
    trigger = flow_version.get('trigger', {})

    if trigger_payload is not None:
        trigger_name = trigger.get('name', 'trigger')
        step_outputs[trigger_name] = {
            'output': trigger_payload,
            'type': 'TRIGGER',
            'status': 'SUCCEEDED',
        }

    # Store trigger output if not already stored
    trigger_name = trigger.get('name', 'trigger')
    if trigger_name not in step_outputs:
        step_outputs[trigger_name] = {
            'output': trigger.get('settings', {}).get('inputUiInfo', {}).get('currentSelectedData'),
            'type': 'TRIGGER',
            'status': 'SUCCEEDED',
        }

    # Notify AP that execution has started (via activity — NOT inline HTTP)
    if callback_url:
        yield ctx.call_activity(send_ap_callback, input={
            'callbackUrl': callback_url,
            'payload': {
                'flowRunId': flow_run_id,
                'status': 'RUNNING',
            },
        })

    try:
        # Walk the AP flow action chain
        yield from _walk_action_chain(
            ctx=ctx,
            action=trigger.get('nextAction'),
            step_outputs=step_outputs,
            flow_run_id=flow_run_id,
            callback_url=callback_url,
            project_id=project_id,
            platform_id=platform_id,
            execute_action=execute_action,
            send_ap_callback=send_ap_callback,
            send_ap_step_update=send_ap_step_update,
        )

        logger.info(
            f"[APWorkflow] Flow completed successfully: run={flow_run_id}, "
            f"steps={len(step_outputs)}"
        )

        # Send completion callback (via activity)
        if callback_url:
            yield ctx.call_activity(send_ap_callback, input={
                'callbackUrl': callback_url,
                'payload': {
                    'flowRunId': flow_run_id,
                    'status': 'SUCCEEDED',
                    'steps': _format_step_outputs(step_outputs),
                },
            })

        return {
            'status': 'SUCCEEDED',
            'steps': step_outputs,
        }

    except Exception as e:
        error_msg = str(e)
        logger.error(f"[APWorkflow] Flow failed: run={flow_run_id}, error={error_msg}")

        # Find the failed step (deterministic scan)
        failed_step = None
        for step_name, step_data in step_outputs.items():
            if isinstance(step_data, dict) and step_data.get('status') == 'FAILED':
                failed_step = {
                    'name': step_name,
                    'displayName': step_name,
                    'message': step_data.get('errorMessage', error_msg),
                }
                break

        # Send failure callback (via activity)
        if callback_url:
            yield ctx.call_activity(send_ap_callback, input={
                'callbackUrl': callback_url,
                'payload': {
                    'flowRunId': flow_run_id,
                    'status': 'FAILED',
                    'steps': _format_step_outputs(step_outputs),
                    'failedStep': failed_step or {
                        'name': 'unknown',
                        'displayName': 'Unknown',
                        'message': error_msg,
                    },
                },
            })

        return {
            'status': 'FAILED',
            'error': error_msg,
            'steps': step_outputs,
            'failedStep': failed_step,
        }


# --- Action chain walker (generator, yields Dapr primitives) ---

def _walk_action_chain(
    ctx: wf.DaprWorkflowContext,
    action: dict[str, Any] | None,
    step_outputs: dict[str, Any],
    flow_run_id: str,
    callback_url: str,
    project_id: str,
    platform_id: str,
    execute_action,
    send_ap_callback,
    send_ap_step_update,
):
    """
    Walk an AP action chain (linked list via nextAction).

    All I/O goes through yield ctx.call_activity().
    ROUTER and LOOP_ON_ITEMS contain no I/O — only deterministic
    dict operations and recursive yields to activities.
    """
    from core.ap_variable_resolver import resolve_ap_value
    from core.ap_condition_evaluator import evaluate_branches

    current = action

    while current is not None:
        action_type = current.get('type')
        action_name = current.get('name', 'unknown')

        if current.get('skip', False):
            current = current.get('nextAction')
            continue

        logger.info(f"[APWalker] Executing step: {action_name} (type={action_type})")

        try:
            if action_type == 'PIECE':
                yield from _handle_piece(
                    ctx, current, step_outputs, execute_action,
                    send_ap_callback, project_id, platform_id,
                    flow_run_id, callback_url,
                )

            elif action_type == 'CODE':
                yield from _handle_code(
                    ctx, current, step_outputs, execute_action,
                )

            elif action_type == 'ROUTER':
                yield from _handle_router(
                    ctx, current, step_outputs, flow_run_id, callback_url,
                    project_id, platform_id, execute_action,
                    send_ap_callback, send_ap_step_update,
                    resolve_ap_value, evaluate_branches,
                )

            elif action_type == 'LOOP_ON_ITEMS':
                yield from _handle_loop(
                    ctx, current, step_outputs, flow_run_id, callback_url,
                    project_id, platform_id, execute_action,
                    send_ap_callback, send_ap_step_update,
                    resolve_ap_value,
                )

            else:
                logger.warning(f"[APWalker] Unknown action type: {action_type}")
                step_outputs[action_name] = {
                    'type': action_type,
                    'status': 'FAILED',
                    'errorMessage': f'Unknown action type: {action_type}',
                }

        except Exception as e:
            step_outputs[action_name] = {
                'type': action_type,
                'status': 'FAILED',
                'errorMessage': str(e),
            }
            raise

        # Send per-step progress update (via activity)
        if callback_url and action_name in step_outputs:
            yield ctx.call_activity(send_ap_step_update, input={
                'callbackUrl': callback_url,
                'payload': {
                    'flowRunId': flow_run_id,
                    'stepName': action_name,
                    'stepOutput': step_outputs[action_name],
                },
            })

        current = current.get('nextAction')


# --- Step handlers ---

def _handle_piece(
    ctx, action, step_outputs, execute_action,
    send_ap_callback, project_id, platform_id,
    flow_run_id, callback_url,
):
    """Handle PIECE action using yield for Dapr activity call."""
    from core.ap_variable_resolver import resolve_ap_value

    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    piece_name = settings.get('pieceName', '')
    ap_action_name = settings.get('actionName', '')
    input_data = settings.get('input', {})

    resolved_input = resolve_ap_value(input_data, step_outputs)
    slug = build_function_slug(piece_name, ap_action_name)

    # Extract connection externalId from the raw (unresolved) auth input.
    # AP stores it as {{connections['<externalId>']}} which is NOT
    # a step variable — it's AP-internal. Extract the literal externalId.
    raw_auth = input_data.get('auth') if isinstance(input_data, dict) else None
    connection_id = extract_connection_id(raw_auth)

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
    pause_data = result.get('pause')

    if pause_data and isinstance(pause_data, dict):
        pause_type = pause_data.get('type')

        if pause_type == 'DELAY':
            # delaySeconds is computed server-side by fn-activepieces
            delay_seconds = pause_data.get('delaySeconds', 0)
            resume_dt_str = pause_data.get('resumeDateTime', '')

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

            # Notify AP that the flow is paused (via activity)
            if callback_url:
                yield ctx.call_activity(send_ap_callback, input={
                    'callbackUrl': callback_url,
                    'payload': {
                        'flowRunId': flow_run_id,
                        'status': 'PAUSED',
                        'pauseMetadata': {
                            'type': 'DELAY',
                            'resumeDateTime': resume_dt_str,
                        },
                        'steps': _format_step_outputs(step_outputs),
                    },
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

            # Notify AP that the flow is paused (via activity)
            if callback_url:
                yield ctx.call_activity(send_ap_callback, input={
                    'callbackUrl': callback_url,
                    'payload': {
                        'flowRunId': flow_run_id,
                        'status': 'PAUSED',
                        'pauseMetadata': {
                            'type': 'WEBHOOK',
                            'requestId': request_id,
                            'response': pause_data.get('response', {}),
                            'daprInstanceId': ctx.instance_id,
                        },
                        'steps': _format_step_outputs(step_outputs),
                    },
                })

            # Wait for external event (resume callback) — Dapr durable primitive
            resume_event = ctx.wait_for_external_event(f'resume-{request_id}')
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

    # Normal completion (no pause)
    step_outputs[action_name] = {
        'type': 'PIECE',
        'status': 'SUCCEEDED' if result.get('success') else 'FAILED',
        'input': resolved_input,
        'output': result.get('data'),
        'errorMessage': result.get('error'),
    }

    if not result.get('success'):
        raise RuntimeError(f"Piece {slug} failed: {result.get('error')}")


def _handle_code(ctx, action, step_outputs, execute_action):
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


def _handle_router(
    ctx, action, step_outputs, flow_run_id, callback_url,
    project_id, platform_id, execute_action,
    send_ap_callback, send_ap_step_update,
    resolve_ap_value, evaluate_branches,
):
    """
    Handle ROUTER action by evaluating conditions and recursing.

    Condition evaluation is deterministic (no I/O) — safe in workflow.
    Branch execution recurses into _walk_action_chain which yields activities.
    """
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
            yield from _walk_action_chain(
                ctx=ctx,
                action=children[i],
                step_outputs=step_outputs,
                flow_run_id=flow_run_id,
                callback_url=callback_url,
                project_id=project_id,
                platform_id=platform_id,
                execute_action=execute_action,
                send_ap_callback=send_ap_callback,
                send_ap_step_update=send_ap_step_update,
            )
        if execution_type == 'EXECUTE_FIRST_MATCH':
            break


def _handle_loop(
    ctx, action, step_outputs, flow_run_id, callback_url,
    project_id, platform_id, execute_action,
    send_ap_callback, send_ap_step_update,
    resolve_ap_value,
):
    """
    Handle LOOP_ON_ITEMS action by iterating and recursing.

    The loop itself is deterministic (iterating a resolved list).
    Each iteration's actions go through yield ctx.call_activity().
    """
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
            yield from _walk_action_chain(
                ctx=ctx,
                action=first_loop_action,
                step_outputs=step_outputs,
                flow_run_id=flow_run_id,
                callback_url=callback_url,
                project_id=project_id,
                platform_id=platform_id,
                execute_action=execute_action,
                send_ap_callback=send_ap_callback,
                send_ap_step_update=send_ap_step_update,
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
