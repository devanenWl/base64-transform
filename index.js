const MODULE_NAME = 'Base64PromptTransform';

function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}

function transformBase64Markers(text) {
    if (typeof text !== 'string') {
        return text;
    }

    return text.replace(
        /\[\[b64\]\]([\s\S]*?)\[\[\/b64\]\]/gi,
        (_, content) => encodeBase64Utf8(content),
    );
}

function transformContent(content) {
    if (typeof content === 'string') {
        return transformBase64Markers(content);
    }

    if (Array.isArray(content)) {
        for (const part of content) {
            if (
                part &&
                typeof part === 'object' &&
                typeof part.text === 'string'
            ) {
                part.text = transformBase64Markers(part.text);
            }
        }
    }

    return content;
}

function transformMessages(messages) {
    if (!Array.isArray(messages)) {
        return;
    }

    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            continue;
        }

        if ('content' in message) {
            message.content = transformContent(message.content);
        }
    }
}

const {
    eventSource,
    event_types,
} = SillyTavern.getContext();

/**
 * IMPORTANT:
 * At this point the Chat Completion prompt has already been assembled.
 * This is where we want to consume markers inserted by Prompt-Only Regex.
 */
eventSource.on(
    event_types.CHAT_COMPLETION_PROMPT_READY,
    (eventData) => {
        console.debug(
            `[${MODULE_NAME}] CHAT_COMPLETION_PROMPT_READY`,
            eventData,
        );

        if (!eventData) {
            return;
        }

        /*
         * Current ST passes:
         *
         * {
         *     chat: [...]
         * }
         */
        if (Array.isArray(eventData.chat)) {
            transformMessages(eventData.chat);

            console.debug(
                `[${MODULE_NAME}] Base64 transformed prompt:`,
                eventData.chat,
            );
        }
    },
);

console.log(`[${MODULE_NAME}] Loaded.`);
