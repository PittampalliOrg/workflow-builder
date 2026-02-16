import type { ResultComponentProps } from "../registry";

export function MastraAgentResult({ output }: ResultComponentProps) {
	if (output == null) {
		return <div className="text-sm text-muted-foreground">No output</div>;
	}

	return (
		<pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
			{JSON.stringify(output, null, 2)}
		</pre>
	);
}
