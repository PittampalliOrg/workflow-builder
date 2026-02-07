"""
AP Flow Walker

Walks Activepieces' linked-list flow format natively:

  FlowVersion.trigger
    .nextAction -> {type: PIECE, settings: {...}, nextAction: ->}
                    .nextAction -> {type: ROUTER, children: [branch1, branch2], ...}
                                    .nextAction -> null (end)

Action types:
  PIECE -> call function-router (via execute_action activity)
  CODE  -> call fn-activepieces /execute-code endpoint
  ROUTER -> evaluate conditions, recurse into matching branch chains
  LOOP_ON_ITEMS -> resolve items, iterate, recurse into firstLoopAction chain
"""

from __future__ import annotations

import logging
import time
from typing import Any

import dapr.ext.workflow as wf

from core.ap_variable_resolver import resolve_ap_value
from core.ap_condition_evaluator import evaluate_branches

logger = logging.getLogger(__name__)


def normalize_piece_name(piece_name: str) -> str:
    """
    Normalize an AP piece name to a function slug.
    Strips the @activepieces/piece- prefix.

    e.g. '@activepieces/piece-google-sheets' -> 'google-sheets'
    """
    if piece_name.startswith('@activepieces/piece-'):
        return piece_name[len('@activepieces/piece-'):]
    return piece_name


def build_function_slug(piece_name: str, action_name: str) -> str:
    """
    Build a function-router slug from AP piece/action names.

    e.g. ('google-sheets', 'insert_row') -> 'google-sheets/insert_row'
    """
    normalized = normalize_piece_name(piece_name)
    return f"{normalized}/{action_name}"


async def walk_ap_flow(
    ctx: wf.DaprWorkflowContext,
    trigger: dict[str, Any],
    step_outputs: dict[str, Any],
    flow_run_id: str,
    callback_url: str,
    connections: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Walk an AP flow starting from the trigger's nextAction.

    Args:
        ctx: Dapr workflow context
        trigger: The flow trigger object (contains nextAction)
        step_outputs: Accumulated step outputs (mutated during walk)
        flow_run_id: The AP flow run ID for callbacks
        callback_url: URL to call for progress/completion updates
        connections: Connection credentials map

    Returns:
        Final step_outputs map
    """
    # Store trigger output
    trigger_name = trigger.get('name', 'trigger')
    step_outputs[trigger_name] = {
        'output': trigger.get('settings', {}).get('inputUiInfo', {}).get('currentSelectedData'),
        'type': 'TRIGGER',
        'status': 'SUCCEEDED',
    }

    # Walk the action chain starting from trigger.nextAction
    current_action = trigger.get('nextAction')
    await _walk_action_chain(
        ctx=ctx,
        action=current_action,
        step_outputs=step_outputs,
        flow_run_id=flow_run_id,
        callback_url=callback_url,
        connections=connections,
    )

    return step_outputs


async def _walk_action_chain(
    ctx: wf.DaprWorkflowContext,
    action: dict[str, Any] | None,
    step_outputs: dict[str, Any],
    flow_run_id: str,
    callback_url: str,
    connections: dict[str, Any] | None = None,
) -> None:
    """Walk a chain of actions (linked list via nextAction)."""
    current = action

    while current is not None:
        action_type = current.get('type')
        action_name = current.get('name', 'unknown')
        display_name = current.get('displayName', action_name)

        # Skip if marked as skipped
        if current.get('skip', False):
            logger.info(f"[APWalker] Skipping step: {action_name}")
            current = current.get('nextAction')
            continue

        logger.info(f"[APWalker] Executing step: {action_name} (type={action_type})")
        start_time = time.time()

        try:
            if action_type == 'PIECE':
                await _handle_piece(ctx, current, step_outputs, connections)
            elif action_type == 'CODE':
                await _handle_code(ctx, current, step_outputs)
            elif action_type == 'ROUTER':
                await _handle_router(ctx, current, step_outputs, flow_run_id, callback_url, connections)
            elif action_type == 'LOOP_ON_ITEMS':
                await _handle_loop(ctx, current, step_outputs, flow_run_id, callback_url, connections)
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
            logger.error(f"[APWalker] Step {action_name} failed: {e}")
            step_outputs[action_name] = {
                'type': action_type,
                'status': 'FAILED',
                'errorMessage': str(e),
                'duration': duration_ms,
            }
            # Stop execution on failure
            raise

        # Move to next action in the chain
        current = current.get('nextAction')


async def _handle_piece(
    ctx: wf.DaprWorkflowContext,
    action: dict[str, Any],
    step_outputs: dict[str, Any],
    connections: dict[str, Any] | None,
) -> None:
    """Handle a PIECE action by calling function-router."""
    from activities.execute_action import execute_action

    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    piece_name = settings.get('pieceName', '')
    ap_action_name = settings.get('actionName', '')
    input_data = settings.get('input', {})

    # Resolve template variables in input
    resolved_input = resolve_ap_value(input_data, step_outputs)

    # Build the function-router slug
    slug = build_function_slug(piece_name, ap_action_name)

    # Build connection external ID if available
    connection_id = None
    auth_input = resolved_input.get('auth') if isinstance(resolved_input, dict) else None
    if isinstance(auth_input, str) and auth_input:
        connection_id = auth_input

    # Build the execute_action input (matches our existing activity format)
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
    }

    # Call execute_action as a Dapr activity
    result = yield ctx.call_activity(
        activity=execute_action,
        input=activity_input,
    )

    step_outputs[action_name] = {
        'type': 'PIECE',
        'status': 'SUCCEEDED' if result.get('success') else 'FAILED',
        'input': resolved_input,
        'output': result.get('data'),
        'errorMessage': result.get('error'),
    }


async def _handle_code(
    ctx: wf.DaprWorkflowContext,
    action: dict[str, Any],
    step_outputs: dict[str, Any],
) -> None:
    """Handle a CODE action by calling fn-activepieces /execute-code."""
    from activities.execute_action import execute_action

    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    source_code = settings.get('sourceCode', {})
    input_data = settings.get('input', {})

    # Resolve template variables in input
    resolved_input = resolve_ap_value(input_data, step_outputs)

    # Build a node that routes to fn-activepieces for code execution
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


async def _handle_router(
    ctx: wf.DaprWorkflowContext,
    action: dict[str, Any],
    step_outputs: dict[str, Any],
    flow_run_id: str,
    callback_url: str,
    connections: dict[str, Any] | None,
) -> None:
    """Handle a ROUTER action by evaluating conditions and recursing into branches."""
    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    branches = settings.get('branches', [])
    children = action.get('children', [])
    execution_type = settings.get('executionType', 'EXECUTE_FIRST_MATCH')

    # Resolve input for condition evaluation
    resolved_settings = resolve_ap_value(settings, step_outputs)
    resolved_branches = resolved_settings.get('branches', branches)

    # Evaluate all branch conditions
    evaluations = evaluate_branches(resolved_branches, resolved_settings)

    # Record router output
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

    # Execute matching branches
    for i, should_execute in enumerate(evaluations):
        if not should_execute:
            continue

        if i < len(children) and children[i] is not None:
            logger.info(f"[APWalker] Entering branch {i+1} of router {action_name}")
            await _walk_action_chain(
                ctx=ctx,
                action=children[i],
                step_outputs=step_outputs,
                flow_run_id=flow_run_id,
                callback_url=callback_url,
                connections=connections,
            )

        # For EXECUTE_FIRST_MATCH, stop after first match
        if execution_type == 'EXECUTE_FIRST_MATCH':
            break


async def _handle_loop(
    ctx: wf.DaprWorkflowContext,
    action: dict[str, Any],
    step_outputs: dict[str, Any],
    flow_run_id: str,
    callback_url: str,
    connections: dict[str, Any] | None,
) -> None:
    """Handle a LOOP_ON_ITEMS action by iterating and recursing."""
    action_name = action.get('name', 'unknown')
    settings = action.get('settings', {})
    items_expr = settings.get('items')
    first_loop_action = action.get('firstLoopAction')

    # Resolve the items expression
    resolved_items = resolve_ap_value(items_expr, step_outputs)

    if not isinstance(resolved_items, list):
        logger.error(f"[APWalker] Loop items is not a list: {type(resolved_items)}")
        step_outputs[action_name] = {
            'type': 'LOOP_ON_ITEMS',
            'status': 'FAILED',
            'errorMessage': 'The items you have selected must be a list.',
        }
        raise ValueError('Loop items must be a list')

    # Initialize loop output
    iterations: list[dict[str, Any]] = []

    for i, item in enumerate(resolved_items):
        logger.info(f"[APWalker] Loop {action_name} iteration {i+1}/{len(resolved_items)}")

        # Set current item in loop output so inner steps can reference it
        step_outputs[action_name] = {
            'type': 'LOOP_ON_ITEMS',
            'status': 'SUCCEEDED',
            'output': {
                'current_item': item,
                'current_iteration': i + 1,
                'iterations': iterations,
            },
        }

        # Execute the loop body
        if first_loop_action is not None:
            await _walk_action_chain(
                ctx=ctx,
                action=first_loop_action,
                step_outputs=step_outputs,
                flow_run_id=flow_run_id,
                callback_url=callback_url,
                connections=connections,
            )

        iterations.append({'index': i + 1, 'item': item})

    # Final loop output
    step_outputs[action_name] = {
        'type': 'LOOP_ON_ITEMS',
        'status': 'SUCCEEDED',
        'output': {
            'iterations': iterations,
            'item_count': len(resolved_items),
        },
    }
