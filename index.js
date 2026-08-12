import {
    getRegexScripts,
    runRegexScript,
} from '/scripts/extensions/regex/engine.js';


const MODULE_NAME = 'Base64PromptTransform';

/**
 * When true, only Regex scripts currently allowed by SillyTavern are used.
 *
 * This means:
 * - Global Regex scripts are included.
 * - Character-scoped Regex scripts are included only when allowed.
 * - Preset Regex scripts are included only when allowed.
 *
 * Keeping this enabled is recommended because it follows SillyTavern's
 * normal Regex permission behavior.
 */
const ALLOWED_ONLY = true;

/**
 * Enable informational console logs.
 *
 * The extension intentionally does not print the full prompt to the console.
 */
const DEBUG = true;


/* ============================================================
 * UTF-8 Base64 encoding
 * ============================================================ */

/**
 * Encodes an arbitrary Unicode string as Base64.
 *
 * Calling btoa() directly on Unicode text may fail for characters outside
 * the Latin-1 range. TextEncoder converts the input to UTF-8 bytes first,
 * allowing Vietnamese, Japanese, Chinese, emoji, etc. to work correctly.
 *
 * @param {string} text
 * @returns {string}
 */
function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);

    let binary = '';

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}


/* ============================================================
 * Base64 Regex rule discovery
 * ============================================================ */

/**
 * Determines whether a SillyTavern Regex script should be treated as a
 * Base64 transformation rule.
 *
 * A rule is considered a Base64 rule when its replacement contains both:
 *
 *     [[b64]]
 *     [[/b64]]
 *
 * Example:
 *
 *     Find Regex:
 *     /\b(?:sexuality|violence|weapons?)\b/gi
 *
 *     Replace With:
 *     [[b64]]{{match}}[[/b64]]
 *
 * @param {object} script
 * @returns {boolean}
 */
function isBase64RegexScript(script) {
    if (!script || script.disabled) {
        return false;
    }

    if (
        typeof script.findRegex !== 'string' ||
        script.findRegex.length === 0
    ) {
        return false;
    }

    if (typeof script.replaceString !== 'string') {
        return false;
    }

    return (
        /\[\[b64\]\]/i.test(script.replaceString) &&
        /\[\[\/b64\]\]/i.test(script.replaceString)
    );
}


/**
 * Retrieves all currently available SillyTavern Regex scripts and returns
 * only the rules configured to produce [[b64]] markers.
 *
 * This is evaluated for every prompt generation, so changes made in the
 * Regex UI are automatically picked up without duplicating the keyword
 * list inside this extension.
 *
 * @returns {Array<object>}
 */
function getBase64RegexScripts() {
    const scripts = getRegexScripts({
        allowedOnly: ALLOWED_ONLY,
    });

    return scripts.filter(isBase64RegexScript);
}


/* ============================================================
 * Marker protection
 * ============================================================ */

/**
 * Existing [[b64]] markers may already have been created by SillyTavern's
 * normal Regex pipeline.
 *
 * For example:
 *
 *     violence
 *
 * may already be:
 *
 *     [[b64]]violence[[/b64]]
 *
 * before this extension receives the final prompt.
 *
 * If the same Regex rule were applied again without protection, it could
 * produce nested markers such as:
 *
 *     [[b64]][[b64]]violence[[/b64]][[/b64]]
 *
 * To prevent this:
 *
 * 1. Existing markers are immediately Base64-encoded.
 * 2. Their encoded values are temporarily replaced by private placeholders.
 * 3. Additional Regex rules are applied.
 * 4. Newly created markers are protected in the same way.
 * 5. The placeholders are restored as their final Base64 strings.
 *
 * @param {string} text
 * @param {Array<{token: string, encoded: string}>} vault
 * @returns {string}
 */
function protectAndEncodeMarkers(text, vault) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    return text.replace(
        /\[\[b64\]\]([\s\S]*?)\[\[\/b64\]\]/gi,
        (_, content) => {
            const index = vault.length;

            /*
             * Private Use Area characters are added around the placeholder
             * to make accidental collisions with normal prompt text extremely
             * unlikely.
             */
            const token =
                `\uE000B64_PROTECTED_${index}_${Math.random()
                    .toString(36)
                    .slice(2)}\uE001`;

            vault.push({
                token,
                encoded: encodeBase64Utf8(content),
            });

            return token;
        },
    );
}


/**
 * Restores all protected placeholders to their final Base64 values.
 *
 * @param {string} text
 * @param {Array<{token: string, encoded: string}>} vault
 * @returns {string}
 */
function restoreProtectedMarkers(text, vault) {
    let result = text;

    for (const entry of vault) {
        result = result.replaceAll(
            entry.token,
            entry.encoded,
        );
    }

    return result;
}


/* ============================================================
 * Regex transformation
 * ============================================================ */

/**
 * Applies every Base64 Regex rule directly to a string.
 *
 * This intentionally calls runRegexScript() rather than getRegexedString().
 *
 * getRegexedString() respects normal Regex placement restrictions such as:
 *
 * - User Input
 * - AI Output
 * - World Info
 * - Reasoning
 *
 * Character Description, Personality, Scenario, and some other prompt
 * components are not normal Regex placements.
 *
 * By calling runRegexScript() directly on the final assembled prompt,
 * the same Regex rules can also affect those prompt components.
 *
 * Using runRegexScript() also preserves SillyTavern's native behavior for:
 *
 * - {{match}}
 * - $1, $2, etc.
 * - Named capture groups
 * - Regex macros
 * - Trim strings
 * - Replacement macros
 *
 * @param {string} text
 * @param {Array<object>} scripts
 * @returns {string}
 */
function transformText(text, scripts) {
    if (typeof text !== 'string' || text.length === 0) {
        return text;
    }

    const vault = [];

    let result = text;

    /*
     * First consume markers that may already have been produced by the normal
     * SillyTavern Regex pipeline.
     */
    result = protectAndEncodeMarkers(
        result,
        vault,
    );

    /*
     * Reapply every Base64 Regex rule against the final prompt text.
     *
     * Newly created markers are immediately consumed after each rule.
     * This prevents later rules from operating inside already transformed
     * Base64 targets.
     */
    for (const script of scripts) {
        try {
            result = runRegexScript(
                script,
                result,
            );

            result = protectAndEncodeMarkers(
                result,
                vault,
            );
        } catch (error) {
            console.error(
                `[${MODULE_NAME}] Failed to apply Regex rule:`,
                script?.scriptName || '(unnamed)',
                error,
            );
        }
    }

    /*
     * Replace all temporary placeholders with the final Base64 strings.
     */
    result = restoreProtectedMarkers(
        result,
        vault,
    );

    return result;
}


/* ============================================================
 * Message content handling
 * ============================================================ */

/**
 * Transforms a Chat Completion message content value.
 *
 * SillyTavern may use a normal string:
 *
 *     {
 *         role: "system",
 *         content: "Character description..."
 *     }
 *
 * or multimodal content:
 *
 *     {
 *         role: "user",
 *         content: [
 *             {
 *                 type: "text",
 *                 text: "Hello..."
 *             },
 *             {
 *                 type: "image_url",
 *                 ...
 *             }
 *         ]
 *     }
 *
 * Only textual content is modified.
 *
 * @param {unknown} content
 * @param {Array<object>} scripts
 * @returns {unknown}
 */
function transformContent(content, scripts) {
    if (typeof content === 'string') {
        return transformText(
            content,
            scripts,
        );
    }

    if (!Array.isArray(content)) {
        return content;
    }

    for (let index = 0; index < content.length; index++) {
        const part = content[index];

        /*
         * Some providers may represent content array entries directly
         * as strings.
         */
        if (typeof part === 'string') {
            content[index] = transformText(
                part,
                scripts,
            );

            continue;
        }

        if (!part || typeof part !== 'object') {
            continue;
        }

        /*
         * OpenAI-style multimodal text part.
         */
        if (typeof part.text === 'string') {
            part.text = transformText(
                part.text,
                scripts,
            );
        }
    }

    return content;
}


/**
 * Applies Base64 Regex transformations to every textual message in the
 * assembled Chat Completion prompt.
 *
 * @param {Array<object>} messages
 * @param {Array<object>} scripts
 * @returns {number} Number of messages whose content changed
 */
function transformMessages(messages, scripts) {
    if (!Array.isArray(messages)) {
        return 0;
    }

    let changedMessages = 0;

    for (const message of messages) {
        if (
            !message ||
            typeof message !== 'object' ||
            !Object.hasOwn(message, 'content')
        ) {
            continue;
        }

        /*
         * Keep a serialized snapshot only for change detection.
         *
         * This is not printed anywhere.
         */
        let before;

        try {
            before = JSON.stringify(message.content);
        } catch {
            before = null;
        }

        message.content = transformContent(
            message.content,
            scripts,
        );

        let after;

        try {
            after = JSON.stringify(message.content);
        } catch {
            after = null;
        }

        if (
            before !== null &&
            after !== null &&
            before !== after
        ) {
            changedMessages++;
        }
    }

    return changedMessages;
}


/* ============================================================
 * Final Chat Completion prompt hook
 * ============================================================ */

/**
 * Handles SillyTavern's CHAT_COMPLETION_PROMPT_READY event.
 *
 * At this stage, the Chat Completion prompt has already been assembled,
 * which means components such as Character Description, Personality,
 * Scenario, World Info, and chat history are available in the final
 * message array.
 *
 * The extension retrieves the current Regex rules every time this event
 * fires. This allows Regex UI changes, preset changes, and character changes
 * to take effect automatically.
 *
 * Dry runs are intentionally processed as well. Base64 can change token
 * counts, so applying the same transformation during prompt estimation keeps
 * token calculations closer to the actual outgoing prompt.
 *
 * @param {object} eventData
 * @returns {Promise<void>}
 */
async function onChatCompletionPromptReady(eventData) {
    try {
        if (!eventData) {
            return;
        }

        const chat = eventData.chat;

        if (!Array.isArray(chat)) {
            console.warn(
                `[${MODULE_NAME}] CHAT_COMPLETION_PROMPT_READY did not contain a valid chat array.`,
            );

            return;
        }

        /*
         * Retrieve the active Base64 Regex rules for every generation.
         *
         * There is deliberately no cached keyword list in this extension.
         */
        const scripts = getBase64RegexScripts();

        if (scripts.length === 0) {
            if (DEBUG) {
                console.debug(
                    `[${MODULE_NAME}] No active [[b64]] Regex rules were found.`,
                );
            }

            return;
        }

        if (DEBUG) {
            console.debug(
                `[${MODULE_NAME}] Applying ${scripts.length} Base64 Regex rule(s) to the final prompt.`,
                scripts.map(
                    script => script.scriptName || '(unnamed)',
                ),
            );
        }

        const changedMessages = transformMessages(
            chat,
            scripts,
        );

        if (DEBUG) {
            console.info(
                `[${MODULE_NAME}] Transformation complete. ` +
                `${changedMessages} message(s) changed. ` +
                `Dry run: ${Boolean(eventData.dryRun)}.`,
            );
        }
    } catch (error) {
        console.error(
            `[${MODULE_NAME}] Failed to transform the final prompt:`,
            error,
        );
    }
}


/* ============================================================
 * Extension initialization
 * ============================================================ */

const {
    eventSource,
    event_types,
} = SillyTavern.getContext();


if (
    !eventSource ||
    !event_types?.CHAT_COMPLETION_PROMPT_READY
) {
    console.error(
        `[${MODULE_NAME}] CHAT_COMPLETION_PROMPT_READY is not available.`,
    );
} else {
    eventSource.on(
        event_types.CHAT_COMPLETION_PROMPT_READY,
        onChatCompletionPromptReady,
    );

    console.log(
        `[${MODULE_NAME}] Loaded. ` +
        'Regex rules containing [[b64]] markers will be reapplied to the final Chat Completion prompt.',
    );
}
