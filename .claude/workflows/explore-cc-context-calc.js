export const meta = {
  name: 'explore-cc-context-calc',
  description: 'Map how Claude Code calculates context % (token counting, window, thresholds, display)',
  phases: [{ title: 'Explore', detail: 'parallel read-only exploration of claude-code-src' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/claude-code-src/main'
const OUT = {
  type: 'object', additionalProperties: false,
  required: ['findings', 'keyFiles'],
  properties: {
    findings: { type: 'string', description: 'detailed findings with verbatim code quotes' },
    keyFiles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file','detail'], properties: { file: {type:'string'}, lines: {type:'string'}, detail: {type:'string'} } } },
  },
}
const COMMON = `Repo: ${REPO} (Claude Code agent harness source, TypeScript). READ-ONLY. Quote exact code (functions, formulas, constants) with file:line. Be very thorough — check multiple naming conventions.`

const results = await parallel([
  () => agent(`${COMMON}
TASK: Find the CORE context-token counting that powers Claude Code's "context left/used %".
1. How does it compute "tokens currently in context"? From the API response usage of the most recent message? Which fields exactly — input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens? Find the function (grep: 'cache_read_input_tokens', 'usage', 'tokensUsed', 'contextTokens', 'totalTokens', 'countTokens'). Quote the exact summation.
2. Where does the model's context-window size come from (constants per model? 200k/1M? beta header handling)? Quote the table/lookup.
3. The percentage / "percent left" formula: numerator/denominator, any RESERVED amounts subtracted (max output tokens? autocompact buffer?). Quote it.
4. Is there a tokenizer-based estimate anywhere, or is it purely provider-usage-based? What happens BEFORE the first API call of a session (what does /context show)?
Look in: context.ts, context/, constants/, anything named tokens*, compact*, autoCompact*.`, { label: 'explore:core-token-math', phase: 'Explore', schema: OUT, agentType: 'Explore' }),
  () => agent(`${COMMON}
TASK: Find how context % is DISPLAYED and UPDATED in Claude Code.
1. The /context command implementation: what breakdown does it show (system prompt, tools, MCP, messages, free space)? How does it compute each segment? Quote.
2. The statusline / UI indicator for context (percentLeft, context bar): when does it refresh (per assistant message? per API call?), and which message's usage does it read (the LAST assistant message)?
3. The 'context low' warnings: at which thresholds do they fire? Quote the constants.
4. Does displayed context include cache_read tokens? Show the exact line proving it.
Look in: components/, statusline, cli/, commands/ (context command), hooks/.`, { label: 'explore:display-update', phase: 'Explore', schema: OUT, agentType: 'Explore' }),
  () => agent(`${COMMON}
TASK: Find the AUTO-COMPACT trigger math in Claude Code.
1. The threshold at which auto-compact fires: formula (context window minus what buffers/reserves?), the constants (e.g. autocompact buffer tokens, max output reserve), and the exact comparison. Quote.
2. Is the trigger based on the same token count as the displayed context %? Same function or different?
3. What happens at trigger (compaction flow summary — one paragraph max, focus on the MATH not the prose).
4. Any special handling for 1M-context models (different thresholds/percentages)?
Grep: autoCompact, AUTOCOMPACT, compactThreshold, shouldCompact, microcompact.`, { label: 'explore:autocompact-math', phase: 'Explore', schema: OUT, agentType: 'Explore' }),
])

return results.filter(Boolean)
