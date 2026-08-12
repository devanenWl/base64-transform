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

/**
 * OpenAI-style content can either be:
 *
 * content: "hello"
 *
 * or multimodal:
 *
 * content: [
 *   { type: "text", text: "hello" },
 *   { type: "image_url", ... }
 * ]
 */
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

function onChatCompletionSettingsReady(generateData) {
    if (!generateData || typeof generateData !== 'object') {
        return;
    }

    transformMessages(generateData.messages);

    console.debug(
        `[${MODULE_NAME}] Base64 markers transformed in outgoing prompt.`,
    );
}

const {
    eventSource,
    event_types,
} = SillyTavern.getContext();

eventSource.on(
    event_types.CHAT_COMPLETION_SETTINGS_READY,
    onChatCompletionSettingsReady,
);

console.log(`[${MODULE_NAME}] Loaded.`);
