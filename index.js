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

/**
 * Default state of the tool-call wrapping feature.
 *
 * This is only used before the extension settings are loaded, or when
 * SillyTavern does not expose the settings API. Once the extension is
 * initialized, the value is controlled by the "Tool-call wrapping"
 * checkbox in:
 *
 *     SillyTavern > Extensions > Base64PromptTransform
 *
 * IMPORTANT:
 *
 * Only historical ASSISTANT messages containing Base64-transformed
 * content are eligible for tool-call wrapping.
 *
 * User messages are NEVER rewritten as assistant/tool messages because
 * doing so changes the semantic author of the conversation turn.
 *
 * Example preserved user message:
 *
 *     {
 *         role: "user",
 *         content: "Some dHJhbnNmb3JtZWQ= content"
 *     }
 *
 * Example wrapped assistant message:
 *
 *     {
 *         role: "assistant",
 *         content: null,
 *         tool_calls: [...]
 *     }
 *
 *     {
 *         role: "tool",
 *         tool_call_id: "...",
 *         content: "Some dHJhbnNmb3JtZWQ= content"
 *     }
 *
 * The final message of the prompt is also never wrapped.
 */
let toolWrapEnabled = true;

/**
 * Tool name used in fabricated assistant tool-call pairs.
 *
 * The model does not need an actual implementation of this tool because
 * the tool call and its result already exist in the supplied history.
 */
const TOOL_NAME = 'story_log';

/**
 * A message is considered Base64-bearing when its text contains at least
 * one padded Base64-looking token.
 *
 * NOTE:
 * This is only used to decide whether an assistant history message should
 * be wrapped.
 *
 * User messages are never wrapped regardless of this regex.
 */
const B64_TOKEN_RE = /[A-Za-z0-9+/]{8,}={1,2}/;


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
 *     /\b(?:example|words?)\b/gi
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
 *     example
 *
 * may already be:
 *
 *     [[b64]]example[[/b64]]
 *
 * before this extension receives the final prompt.
 *
 * If the same Regex rule were applied again without protection, it could
 * produce nested markers such as:
 *
 *     [[b64]][[b64]]example[[/b64]][[/b64]]
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
 * IMPORTANT:
 *
 * This transformation does NOT change message roles.
 *
 * A user message stays a user message.
 * An assistant message stays an assistant message.
 * A system message stays a system message.
 *
 * Tool wrapping, if enabled, happens separately afterwards and is restricted
 * to assistant history messages only.
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
 * Tool-call wrapping
 * ============================================================ */

/**
 * Converts a message content value (string or multimodal array) into a
 * plain string for use inside a tool message.
 *
 * @param {unknown} content
 * @returns {string}
 */
function contentToString(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }

                if (
                    part &&
                    typeof part === 'object' &&
                    typeof part.text === 'string'
                ) {
                    return part.text;
                }

                return '';
            })
            .filter((text) => text.length > 0)
            .join('\n');
    }

    return String(content ?? '');
}


/**
 * Determines whether a historical ASSISTANT message should be rewritten
 * as a tool-call pair.
 *
 * User messages are NEVER wrapped.
 *
 * This is intentional because converting:
 *
 *     {
 *         role: "user",
 *         content: "..."
 *     }
 *
 * into:
 *
 *     assistant(tool_calls)
 *     -> tool(content)
 *
 * changes the semantic author of the original turn.
 *
 * A message is eligible only when:
 *
 * - Tool-call wrapping is enabled.
 * - It is not the final message of the prompt.
 * - role === "assistant".
 * - It does not already contain tool_calls.
 * - It contains Base64-looking content.
 *
 * @param {object} message
 * @param {boolean} isLast
 * @returns {boolean}
 */
function shouldWrapMessage(message, isLast) {
    if (!toolWrapEnabled) {
        return false;
    }

    /*
     * Never touch the current/final turn.
     */
    if (isLast) {
        return false;
    }

    /*
     * CRITICAL:
     *
     * Only assistant messages can become assistant -> tool pairs.
     *
     * User messages must remain role: "user".
     */
    if (
        !message ||
        typeof message !== 'object' ||
        message.role !== 'assistant'
    ) {
        return false;
    }

    /*
     * Do not interfere with genuine/existing tool calls.
     */
    if (message.tool_calls) {
        return false;
    }

    const text = contentToString(message.content);

    if (text.length === 0) {
        return false;
    }

    return B64_TOKEN_RE.test(text);
}


/**
 * Rewrites Base64-bearing historical ASSISTANT messages as tool-call pairs:
 *
 * Original:
 *
 *     {
 *         role: "assistant",
 *         content: "..."
 *     }
 *
 * becomes:
 *
 *     {
 *         role: "assistant",
 *         content: null,
 *         tool_calls: [...]
 *     }
 *
 *     {
 *         role: "tool",
 *         tool_call_id: "...",
 *         content: "..."
 *     }
 *
 * USER MESSAGES ARE NEVER WRAPPED.
 *
 * Even if a user message contains Base64, it remains:
 *
 *     {
 *         role: "user",
 *         content: "..."
 *     }
 *
 * The final message of the prompt is also preserved as-is.
 *
 * The chat array is mutated in place so SillyTavern sends the rewritten
 * prompt.
 *
 * @param {Array<object>} chat
 * @returns {number} Number of wrapped assistant messages
 */
function wrapMessagesAsToolPairs(chat) {
    if (!toolWrapEnabled || !Array.isArray(chat)) {
        return 0;
    }

    const wrapped = [];

    let callIndex = 0;
    let wrappedMessages = 0;

    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        const isLast = index === chat.length - 1;

        /*
         * Defensive role-preservation guard.
         *
         * Even if shouldWrapMessage() is accidentally changed in the future,
         * user messages still cannot be converted here.
         */
        if (
            message &&
            typeof message === 'object' &&
            message.role === 'user'
        ) {
            wrapped.push(message);

            continue;
        }

        if (shouldWrapMessage(message, isLast)) {
            callIndex += 1;
            wrappedMessages += 1;

            const callId = `call_${callIndex}`;

            wrapped.push({
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: callId,
                        type: 'function',
                        function: {
                            name: TOOL_NAME,
                            arguments: '{}',
                        },
                    },
                ],
            });

            wrapped.push({
                role: 'tool',
                tool_call_id: callId,
                content: contentToString(message.content),
            });

            continue;
        }

        /*
         * Everything else is preserved exactly as-is.
         *
         * Includes:
         * - user
         * - system
         * - tool
         * - assistant without Base64
         * - assistant with existing tool_calls
         * - final/current message
         */
        wrapped.push(message);
    }

    /*
     * Mutate in place.
     *
     * SillyTavern may retain the original array reference and later use
     * that same reference when constructing the outgoing provider request.
     */
    chat.splice(
        0,
        chat.length,
        ...wrapped,
    );

    return wrappedMessages;
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
 * Processing order:
 *
 * 1. Apply [[b64]] Regex transformations.
 * 2. Preserve every original message role.
 * 3. Optionally wrap historical ASSISTANT Base64 messages.
 * 4. Never wrap user messages.
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
         * Retrieve active Base64 Regex rules for every generation.
         *
         * There is deliberately no cached keyword list in this extension.
         */
        const scripts = getBase64RegexScripts();

        let changedMessages = 0;

        if (scripts.length > 0) {
            if (DEBUG) {
                console.debug(
                    `[${MODULE_NAME}] Applying ${scripts.length} Base64 Regex rule(s) to the final prompt.`,
                    scripts.map(
                        script => script.scriptName || '(unnamed)',
                    ),
                );
            }

            changedMessages = transformMessages(
                chat,
                scripts,
            );
        } else if (DEBUG) {
            console.debug(
                `[${MODULE_NAME}] No active [[b64]] Regex rules were found.`,
            );
        }

        /*
         * Wrap Base64-bearing historical ASSISTANT messages.
         *
         * User messages are intentionally excluded and preserve role:user.
         *
         * This runs even when no [[b64]] rules are active so historical
         * assistant content that was already Base64-encoded by an earlier
         * regex stage can still be detected.
         */
        const wrappedMessages = wrapMessagesAsToolPairs(chat);

        if (
            DEBUG &&
            (
                changedMessages > 0 ||
                wrappedMessages > 0
            )
        ) {
            console.info(
                `[${MODULE_NAME}] Transformation complete. ` +
                `${changedMessages} message(s) Base64-encoded, ` +
                `${wrappedMessages} assistant message(s) wrapped as tool calls. ` +
                `User roles preserved. ` +
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

const context = SillyTavern.getContext();

const {
    eventSource,
    event_types,
    extensionSettings,
    saveSettingsDebounced,
} = context;

/**
 * Namespace used inside the global extensionSettings object so this
 * extension's keys never collide with other extensions.
 */
const EXTENSION_SETTINGS_KEY = 'Base64PromptTransform';

/**
 * Returns this extension's persistent settings object, creating it
 * on first access.
 *
 * The object is stored under:
 *
 *     extensionSettings["Base64PromptTransform"]
 *
 * and persisted by SillyTavern via saveSettingsDebounced().
 *
 * @returns {Record<string, unknown>}
 */
function getExtensionSettings() {
    if (!extensionSettings[EXTENSION_SETTINGS_KEY]) {
        extensionSettings[EXTENSION_SETTINGS_KEY] = {};
    }

    return extensionSettings[EXTENSION_SETTINGS_KEY];
}


/**
 * Loads the stored "Tool-call wrapping" preference from persistent
 * extension settings.
 */
function loadToolWrapSetting() {
    try {
        const stored = getExtensionSettings().tool_wrap;

        if (typeof stored === 'boolean') {
            toolWrapEnabled = stored;
        }
    } catch (error) {
        console.warn(
            `[${MODULE_NAME}] Could not load tool-call wrapping setting:`,
            error,
        );
    }
}


/**
 * Registers the extension settings panel.
 *
 * The panel is appended to SillyTavern's standard extensions settings
 * container:
 *
 *     #extensions_settings2
 *
 * which is normally rendered inside:
 *
 *     SillyTavern
 *       > Extensions
 *       > Extensions
 *       > Settings
 *
 * The checkbox controls whether historical assistant messages containing
 * Base64-looking content may be represented as tool-call history.
 *
 * User messages are never wrapped regardless of this setting.
 */
function registerExtensionSettingsPanel() {
    /*
     * Load persisted value BEFORE rendering the checkbox so the initial
     * checked state is correct.
     */
    loadToolWrapSetting();

    const container = $('#extensions_settings2');

    if (!container || container.length === 0) {
        console.warn(
            `[${MODULE_NAME}] #extensions_settings2 was not found. ` +
            'The settings panel will not be rendered; the stored/source default is used.',
        );

        return;
    }

    /*
     * Avoid duplicate panels if extension initialization somehow runs more
     * than once.
     */
    if ($('#b64pt_settings_panel').length > 0) {
        $('#b64pt_tool_wrap').prop(
            'checked',
            toolWrapEnabled,
        );

        return;
    }

    const panelHtml = `
        <div
            id="b64pt_settings_panel"
            class="inline-drawer b64pt-drawer"
        >
            <div class="inline-drawer-toggle inline-drawer-header">
                <b data-i18n="Base64PromptTransform">
                    Base64PromptTransform
                </b>

                <div
                    class="inline-drawer-icon fa-solid fa-circle-chevron-down down"
                ></div>
            </div>

            <div class="inline-drawer-content">
                <label
                    class="checkbox_label"
                    for="b64pt_tool_wrap"
                >
                    <input
                        id="b64pt_tool_wrap"
                        type="checkbox"
                        ${toolWrapEnabled ? 'checked' : ''}
                    />

                    <span data-i18n="Tool-call wrapping">
                        Tool-call wrapping
                    </span>
                </label>

                <small>
                    Rewrite Base64-bearing historical
                    <strong>assistant</strong> messages as tool-call pairs.
                    User messages always remain
                    <code>role: "user"</code>.
                    Disable this option to keep assistant messages plain too.
                </small>
            </div>
        </div>
    `;

    container.append(panelHtml);

    $('#b64pt_tool_wrap').on(
        'change',
        function () {
            toolWrapEnabled = Boolean(
                $(this).prop('checked'),
            );

            getExtensionSettings().tool_wrap =
                toolWrapEnabled;

            saveSettingsDebounced();

            console.info(
                `[${MODULE_NAME}] Tool-call wrapping set to ` +
                `${toolWrapEnabled ? 'enabled' : 'disabled'}. ` +
                'User messages are never wrapped.',
            );
        },
    );

    /*
     * Keep checkbox synchronized with loaded setting.
     */
    $('#b64pt_tool_wrap').prop(
        'checked',
        toolWrapEnabled,
    );
}


/* ============================================================
 * Start extension
 * ============================================================ */

registerExtensionSettingsPanel();

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
        'Regex rules containing [[b64]] markers will be reapplied to the final Chat Completion prompt. ' +
        'User message roles are always preserved. ' +
        `Assistant tool-call wrapping: ${toolWrapEnabled ? 'enabled' : 'disabled'}.`,
    );
}
