import {
    getRegexScripts,
    runRegexScript,
} from '/scripts/extensions/regex/engine.js';

const MODULE_NAME = 'Base64PromptTransform';

/**
 * true:
 *   - Global regex
 *   - Character/scoped regex chỉ khi đã Allow
 *   - Preset regex chỉ khi đã Allow
 *
 * false:
 *   - lấy cả scoped/preset regex chưa được Allow
 *
 * Khuyên giữ true.
 */
const ALLOWED_ONLY = true;

/**
 * Log tên các rule được sử dụng.
 * Không log toàn bộ prompt để tránh spam/privacy.
 */
const DEBUG = true;


/* ============================================================
 * Base64
 * ============================================================ */

function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);

    let binary = '';

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary);
}


/* ============================================================
 * Detect B64 Regex rules
 * ============================================================ */

/**
 * Chỉ lấy những Regex script có dạng replacement chứa:
 *
 * [[b64]] ... [[/b64]]
 *
 * Ví dụ:
 * [[b64]]{{match}}[[/b64]]
 * [[b64]]$1[[/b64]]
 */
function isBase64RegexScript(script) {
    if (!script || script.disabled) {
        return false;
    }

    if (typeof script.findRegex !== 'string' || !script.findRegex) {
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
 * Lấy tất cả Regex scripts từ Regex engine của SillyTavern,
 * sau đó lọc ra các B64 rules.
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
 * Có một vấn đề:
 *
 * Built-in Regex có thể đã biến:
 *
 * Sexuality
 *
 * thành:
 *
 * [[b64]]Sexuality[[/b64]]
 *
 * trước khi extension này chạy.
 *
 * Nếu chúng ta re-run Regex trực tiếp:
 *
 * [[b64]]Sexuality[[/b64]]
 *
 * có thể thành:
 *
 * [[b64]][[b64]]Sexuality[[/b64]][[/b64]]
 *
 * => encode hai lần / marker bị nested.
 *
 * Vì vậy:
 *
 * 1. tìm marker đang tồn tại
 * 2. Base64 nó
 * 3. tạm thay bằng private placeholder
 * 4. re-run Regex khác
 * 5. cuối cùng restore Base64
 */
function protectAndEncodeMarkers(text, vault) {
    if (typeof text !== 'string' || !text) {
        return text;
    }

    return text.replace(
        /\[\[b64\]\]([\s\S]*?)\[\[\/b64\]\]/gi,
        (_, content) => {
            const id = vault.length;

            const token =
                `\uE000B64PROTECTED_${id}_${Math.random()
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


function restoreProtectedMarkers(text, vault) {
    let result = text;

    for (const item of vault) {
        result = result.replaceAll(
            item.token,
            item.encoded,
        );
    }

    return result;
}


/* ============================================================
 * Apply SillyTavern Regex rules
 * ============================================================ */

/**
 * Quan trọng:
 *
 * Ta gọi runRegexScript() TRỰC TIẾP.
 *
 * Không gọi getRegexedString().
 *
 * Vì getRegexedString() sẽ check:
 *
 *   User Input
 *   AI Output
 *   World Info
 *   Reasoning
 *   placement
 *   depth
 *
 * Character Definition không thuộc các placement đó.
 *
 * runRegexScript() thì apply trực tiếp regex lên raw string.
 */
function transformText(text, scripts) {
    if (typeof text !== 'string' || !text) {
        return text;
    }

    const vault = [];

    let result = text;

    /*
     * Step 1
     *
     * Consume/protect marker đã được built-in Regex tạo ra.
     *
     * Example:
     *
     * [[b64]]BDSM[[/b64]]
     *
     * => temporary placeholder
     */
    result = protectAndEncodeMarkers(
        result,
        vault,
    );


    /*
     * Step 2
     *
     * Re-run EVERY B64 Regex rule against the final prompt.
     *
     * Sau mỗi rule, consume marker ngay lập tức.
     *
     * Việc này tránh rule tiếp theo lại match vào text
     * vừa được rule trước xử lý.
     */
    for (const script of scripts) {
        try {
            result = runRegexScript(
                script,
                result,
            );

            /*
             * Example:
             *
             * Character Definition:
             *
             * Sexuality: Bisexual
             *
             * runRegexScript:
             *
             * [[b64]]Sexuality[[/b64]]: Bisexual
             *
             * protect:
             *
             * <temporary token>: Bisexual
             */
            result = protectAndEncodeMarkers(
                result,
                vault,
            );
        } catch (error) {
            console.error(
                `[${MODULE_NAME}] Failed Regex script:`,
                script?.scriptName ?? '(unnamed)',
                error,
            );
        }
    }


    /*
     * Step 3
     *
     * Restore placeholders thành Base64 thật.
     */
    result = restoreProtectedMarkers(
        result,
        vault,
    );

    return result;
}


/* ============================================================
 * Message content
 * ============================================================ */

function transformContent(content, scripts) {
    /*
     * Normal OpenAI-style content:
     *
     * {
     *   role: "system",
     *   content: "Character Description..."
     * }
     */
    if (typeof content === 'string') {
        return transformText(
            content,
            scripts,
        );
    }


    /*
     * Multimodal content:
     *
     * content: [
     *   {
     *     type: "text",
     *     text: "..."
     *   },
     *   {
     *     type: "image_url",
     *     ...
     *   }
     * ]
     */
    if (Array.isArray(content)) {
        for (const part of content) {
            if (typeof part === 'string') {
                const index = content.indexOf(part);

                if (index !== -1) {
                    content[index] = transformText(
                        part,
                        scripts,
                    );
                }

                continue;
            }

            if (!part || typeof part !== 'object') {
                continue;
            }

            if (typeof part.text === 'string') {
                part.text = transformText(
                    part.text,
                    scripts,
                );
            }
        }

        return content;
    }


    return content;
}


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
         * Debug comparison only.
         */
        let before;

        if (typeof message.content === 'string') {
            before = message.content;
        }

        message.content = transformContent(
            message.content,
            scripts,
        );

        if (
            typeof before === 'string' &&
            before !== message.content
        ) {
            changedMessages++;
        }
    }

    return changedMessages;
}


/* ============================================================
 * Final Prompt Hook
 * ============================================================ */

async function onChatCompletionPromptReady(eventData) {
    try {
        if (!eventData) {
            return;
        }

        /*
         * Prompt Manager / token-count dry run.
         *
         * Không cần encode vì request thật chưa được gửi.
         */
        if (eventData.dryRun) {
            return;
        }

        const chat = eventData.chat;

        if (!Array.isArray(chat)) {
            console.warn(
                `[${MODULE_NAME}] CHAT_COMPLETION_PROMPT_READY ` +
                'did not contain eventData.chat.',
            );

            return;
        }


        /*
         * Đây chính là "API list all regex" bạn muốn.
         *
         * Nó được gọi MỖI generation.
         *
         * Vì thế:
         *
         * - thêm Regex mới => tự nhận
         * - sửa Regex => tự nhận
         * - đổi preset => tự nhận
         * - đổi character => tự nhận
         *
         * Không phải restart extension.
         */
        const scripts = getBase64RegexScripts();

        if (scripts.length === 0) {
            if (DEBUG) {
                console.debug(
                    `[${MODULE_NAME}] No active [[b64]] Regex rules found.`,
                );
            }

            return;
        }


        if (DEBUG) {
            console.debug(
                `[${MODULE_NAME}] Reapplying ${scripts.length} B64 Regex rule(s) to final prompt:`,
                scripts.map((script) =>
                    script.scriptName || '(unnamed)',
                ),
            );
        }


        const changedMessages =
            transformMessages(
                chat,
                scripts,
            );


        console.info(
            `[${MODULE_NAME}] Done. ` +
            `${scripts.length} B64 Regex rule(s), ` +
            `${changedMessages} final prompt message(s) changed.`,
        );
    } catch (error) {
        console.error(
            `[${MODULE_NAME}] Failed to process final prompt:`,
            error,
        );
    }
}


/* ============================================================
 * Init
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
        `[${MODULE_NAME}] CHAT_COMPLETION_PROMPT_READY is unavailable.`,
    );
} else {
    eventSource.on(
        event_types.CHAT_COMPLETION_PROMPT_READY,
        onChatCompletionPromptReady,
    );

    console.log(
        `[${MODULE_NAME}] Loaded. ` +
        'B64 Regex rules will be reapplied to the final Chat Completion prompt.',
    );
}
