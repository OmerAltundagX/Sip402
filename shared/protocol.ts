/** Message the session key signs to request an answer; proves the caller controls the session. */
export const askMessage = (sessionId: string, prompt: string) => `Sip402 ask\nsession: ${sessionId}\nprompt: ${prompt}`;
