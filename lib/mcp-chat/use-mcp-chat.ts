"use client";

import { useState, useCallback, useRef } from "react";
import type { UIMessage } from "ai";
import { DefaultChatTransport, readUIMessageStream, generateId } from "ai";

export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

export function useMcpChat(
	apiUrl: string,
	opts?: { body?: () => Record<string, unknown> },
) {
	const [messages, setMessages] = useState<UIMessage[]>([]);
	const [status, setStatus] = useState<ChatStatus>("ready");
	const [error, setError] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const transportRef = useRef(
		new DefaultChatTransport({ api: apiUrl, body: opts?.body }),
	);

	const sendMessage = useCallback(
		async ({ text }: { text: string }) => {
			const userMessage: UIMessage = {
				id: generateId(),
				role: "user",
				parts: [{ type: "text", text }],
			};

			const updatedMessages = [...messages, userMessage];
			setMessages(updatedMessages);
			setStatus("submitted");
			setError(null);

			const abortController = new AbortController();
			abortRef.current = abortController;

			try {
				const chunkStream = await transportRef.current.sendMessages({
					chatId: "mcp-chat",
					messageId: undefined,
					messages: updatedMessages,
					abortSignal: abortController.signal,
					trigger: "submit-message",
				});

				setStatus("streaming");

				const messageStream = readUIMessageStream({
					stream: chunkStream,
				});

				let latestMessages = updatedMessages;
				for await (const message of messageStream) {
					const existingIdx = latestMessages.findIndex(
						(m) => m.id === message.id,
					);
					if (existingIdx >= 0) {
						latestMessages = [
							...latestMessages.slice(0, existingIdx),
							message,
							...latestMessages.slice(existingIdx + 1),
						];
					} else {
						latestMessages = [...latestMessages, message];
					}
					setMessages([...latestMessages]);
				}

				setStatus("ready");
			} catch (err) {
				if ((err as Error).name !== "AbortError") {
					console.error("Chat error:", err);
					const msg = err instanceof Error ? err.message : "Unknown error";
					setError(msg);
					setStatus("error");
				}
			} finally {
				abortRef.current = null;
			}
		},
		[messages],
	);

	const clearMessages = useCallback(() => {
		setMessages([]);
		setStatus("ready");
		setError(null);
	}, []);

	return {
		messages,
		setMessages,
		sendMessage,
		status,
		error,
		clearMessages,
	};
}
