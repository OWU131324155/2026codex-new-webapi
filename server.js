const express = require('express');
const fs = require('fs');
const path = require('path');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public'));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three')));

app.get('/healthz', (req, res) => {
    res.json({ ok: true });
});

// ===== 設定 =====
// 利用するLLMプロバイダを選択します（'openai' または 'gemini'）
const PROVIDER = process.env.LLM_PROVIDER || 'openai';

// プロバイダごとに利用するモデル
const MODELS = {
    openai: 'gpt-5.5',        // OpenAI（デフォルト）
    gemini: 'gemini-3.5-flash', // Google Gemini
};
const MODEL = process.env.LLM_MODEL || MODELS[PROVIDER];

const PROMPTS = {
    quiz: 'prompt.md',
    story: path.join('prompts', 'story.md'),
};

const promptTemplates = {};
for (const [appId, promptPath] of Object.entries(PROMPTS)) {
    try {
        promptTemplates[appId] = fs.readFileSync(promptPath, 'utf8');
    } catch (error) {
        console.error(`Error reading ${promptPath}:`, error);
        process.exit(1);
    }
}

const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || process.env.OPENAI_ASSISTANT_MODEL || 'gpt-5.5';
const ASSISTANT_SYSTEM_PROMPT = [
    'あなたはAI探偵シミュレーションゲーム内の「探偵事務所の相棒AI」です。',
    'プレイヤーの推理を奪わず、事件のヒント、証拠整理、矛盾の見つけ方、ゲーム操作の説明を日本語で自然に支援します。',
    '答えを直接求められた場合でも、まず根拠、仮説、次に見るべき証拠を短く整理して、最終判断はプレイヤーに委ねます。',
    '返答は会話らしく、原則2〜5文。ノワール調の落ち着いた相棒として振る舞います。',
].join('\n');

// public/ 内の .html 一覧を返す（index.html がこの一覧を使ってリンクを表示する）
app.get('/api/pages', (req, res) => {
    const files = fs.readdirSync('public')
        .filter(name => name.endsWith('.html') && name !== 'index.html');
    res.json(files);
});

app.post('/api/assistant-chat', async (req, res) => {
    try {
        const { message, history = [], context = {} } = req.body || {};
        const trimmedMessage = String(message || '').trim();
        if (!trimmedMessage) {
            return res.status(400).json({ error: 'message is required' });
        }

        const safeHistory = Array.isArray(history)
            ? history
                .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && item.content)
                .slice(-12)
                .map((item) => ({
                    role: item.role,
                    content: String(item.content).slice(0, 1200),
                }))
            : [];

        const contextMessage = buildAssistantContext(context);
        const reply = await callOpenAIAssistant([
            { role: 'system', content: ASSISTANT_SYSTEM_PROMPT },
            { role: 'system', content: contextMessage },
            ...safeHistory,
            { role: 'user', content: trimmedMessage.slice(0, 1200) },
        ]);

        res.json({ reply });
    } catch (error) {
        console.error('Assistant Chat Error:', error);
        res.status(500).json({ error: error.message || 'Failed to chat with assistant.' });
    }
});

app.post('/api/detective', async (req, res) => {
    try {
        const { action, state = {}, option = {}, miniGame = {}, result = {}, generation = {} } = req.body || {};
        if (!action) {
            return res.status(400).json({ error: 'action is required' });
        }

        const prompt = buildDetectivePrompt(action, { state, option, miniGame, result, generation });
        let payload;
        try {
            payload = await withTimeout(
                callOpenAIObject(prompt),
                Number(process.env.DETECTIVE_API_TIMEOUT_MS || 5000),
                'Detective OpenAI request timed out'
            );
        } catch (error) {
            console.warn('Detective API fallback:', error.message || error);
            payload = fallbackDetectivePayload(action, { state, option, miniGame, result, generation });
        }
        res.json(payload);
    } catch (error) {
        console.error('Detective API Error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate detective content.' });
    }
});

// 問題数の上限（過剰なリクエストでトークンを浪費しないようにする）
const MAX_COUNT = 20;

app.post('/api/', async (req, res) => {
    try {
        // title と、変数置換に使うその他のキーを受け取る
        // （prompt.md がプロンプトを定義するので、リクエストでの上書きは許可しない）
        const { title = 'Generated Content', app: appId = 'quiz', ...variables } = req.body;

        const promptTemplate = promptTemplates[appId];
        if (!promptTemplate) {
            return res.status(400).json({ error: 'Invalid app configuration' });
        }

        // count が指定されている場合は 1〜MAX_COUNT の範囲に収める
        if (variables.count !== undefined) {
            const count = Number(variables.count);
            if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
                return res.status(400).json({
                    error: `count must be an integer between 1 and ${MAX_COUNT}`,
                });
            }
        }

        // prompt.md のテンプレート変数 ${key} をリクエストの値で置換する
        const finalPrompt = fillTemplate(promptTemplate, variables);

        let result;
        if (PROVIDER === 'openai') {
            result = await callOpenAI(finalPrompt);
        } else if (PROVIDER === 'gemini') {
            result = await callGemini(finalPrompt);
        } else {
            return res.status(400).json({ error: 'Invalid provider configuration' });
        }

        res.json({
            title: title,
            data: result,
        });

    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate content. Please try again.' });
    }
});

// prompt.md 内の ${key} を variables の値で安全に置換する
function fillTemplate(template, variables) {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(variables, key)
            ? String(variables[key])
            : match; // 対応する値がなければそのまま残す
    });
}

async function callOpenAI(prompt) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set in Render environment variables');
    }

    const controller = new AbortController();
    const abortId = setTimeout(() => controller.abort(), Number(process.env.OPENAI_FETCH_TIMEOUT_MS || 22000));
    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: prompt }
            ],
            max_completion_tokens: 5000,
            response_format: { type: "json_object" }
        })
    }).finally(() => clearTimeout(abortId));

    if (!response.ok) {
        const errorText = await response.text();
        let message = errorText;
        try {
            const error = JSON.parse(errorText);
            message = error.error?.message || errorText;
        } catch (parseError) {
            message = errorText || response.statusText;
        }
        throw new Error(`OpenAI API error (${response.status}): ${message}`);
    }

    const data = await response.json();
    const responseText = data.choices[0].message.content;
    return extractArray(responseText);
}

async function callOpenAIObject(prompt) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set in environment variables');
    }

    const controller = new AbortController();
    const abortId = setTimeout(() => controller.abort(), Number(process.env.OPENAI_FETCH_TIMEOUT_MS || 5500));
    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: prompt }
            ],
            max_completion_tokens: 5000,
            response_format: { type: "json_object" }
        })
    }).finally(() => clearTimeout(abortId));

    if (!response.ok) {
        const errorText = await response.text();
        let message = errorText;
        try {
            const error = JSON.parse(errorText);
            message = error.error?.message || errorText;
        } catch (parseError) {
            message = errorText || response.statusText;
        }
        throw new Error(`OpenAI API error (${response.status}): ${message}`);
    }

    const data = await response.json();
    const responseText = data.choices?.[0]?.message?.content;
    if (!responseText) throw new Error('OpenAI response was empty.');
    try {
        return JSON.parse(responseText);
    } catch (parseError) {
        throw new Error('Failed to parse OpenAI JSON object: ' + parseError.message);
    }
}

async function callOpenAIAssistant(messages) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set in environment variables');
    }

    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: ASSISTANT_MODEL,
            messages,
            max_completion_tokens: 900,
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        let message = errorText;
        try {
            const error = JSON.parse(errorText);
            message = error.error?.message || errorText;
        } catch (parseError) {
            message = errorText || response.statusText;
        }
        throw new Error(`OpenAI API error (${response.status}): ${message}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || 'すみません、今は返答を組み立てられませんでした。';
}

function buildAssistantContext(context) {
    const safeContext = context && typeof context === 'object' ? context : {};
    const scene = safeContext.scene && typeof safeContext.scene === 'object' ? safeContext.scene : {};
    const evidence = Array.isArray(safeContext.evidence) ? safeContext.evidence.slice(-8) : [];
    const testimonies = Array.isArray(safeContext.testimonies) ? safeContext.testimonies.slice(-8) : [];
    const contradictions = Array.isArray(safeContext.contradictions) ? safeContext.contradictions.slice(-6) : [];

    return [
        '現在のゲーム状況:',
        `事件: ${safeContext.caseName || '未選択'}`,
        `ターン: ${safeContext.turn || 0}`,
        `現在地: ${scene.location || '3D探偵事務所'}`,
        `場面: ${scene.sceneTitle || '事務所で待機中'}`,
        `直前の選択: ${safeContext.lastChoice || 'なし'}`,
        `証拠: ${summarizeAssistantItems(evidence, 'title', 'detail')}`,
        `証言: ${summarizeAssistantItems(testimonies, 'speaker', 'claim')}`,
        `確定した矛盾: ${summarizeAssistantItems(contradictions, 'testimonyId', 'explanation')}`,
    ].join('\n');
}

function summarizeAssistantItems(items, primaryKey, secondaryKey) {
    if (!items.length) return 'なし';
    return items.map((item) => {
        const primary = item?.[primaryKey] || '項目';
        const secondary = item?.[secondaryKey] || '';
        return `${primary}: ${secondary}`.slice(0, 180);
    }).join(' / ');
}

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set in Render environment variables');
    }

    const response = await fetch(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                maxOutputTokens: 3000,
                response_mime_type: "application/json"
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        let message = errorText;
        try {
            const error = JSON.parse(errorText);
            message = error.error?.message || errorText;
        } catch (parseError) {
            message = errorText || response.statusText;
        }
        throw new Error(`Gemini API error (${response.status}): ${message}`);
    }

    const data = await response.json();
    const responseText = data.candidates[0].content.parts[0].text;
    return extractArray(responseText);
}

// LLM が返した JSON 文字列をパースし、最初に見つかった配列を取り出す
function extractArray(responseText) {
    let parsedData;
    try {
        parsedData = JSON.parse(responseText);
    } catch (parseError) {
        throw new Error('Failed to parse LLM response: ' + parseError.message);
    }

    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

function buildDetectivePrompt(action, payload) {
    const compactState = JSON.stringify(payload.state || {}).slice(0, 12000);
    const compactOption = JSON.stringify(payload.option || {}).slice(0, 3000);
    const compactMiniGame = JSON.stringify(payload.miniGame || {}).slice(0, 3000);
    const compactResult = JSON.stringify(payload.result || {}).slice(0, 3000);
    const compactGeneration = JSON.stringify(payload.generation || {}).slice(0, 3000);
    const common = [
        'あなたは日本語のAI探偵シミュレーションゲーム用シナリオエンジンです。',
        'ノワールな雰囲気を保ちつつ、プレイヤーが捜査している実感が出る短く具体的な内容を作ります。',
        '最重要条件: 過去の証拠、証言、人物、ターン履歴、ミニゲーム結果と矛盾しないこと。',
        '同じ事件を繰り返さないため、固有名詞、舞台、犯人、動機、トリック、証拠を毎回変えてください。',
        '返答は必ずJSONオブジェクトのみ。Markdownや説明文は禁止。',
    ].join('\n');

    const schemas = {
        'case-options': [
            '3件の事件候補を生成してください。',
            'このリクエスト固有の生成情報を必ず反映し、同じタイトル、同じ舞台、同じ小道具、同じ導入文を再利用しないでください。',
            '3件同士も、場所、職業、被害物、事件の謎、雰囲気、文末表現がすべて明確に違うものにしてください。',
            'previousTitles に含まれるタイトルや近い言い換えは禁止です。',
            `生成情報: ${compactGeneration}`,
            'JSON形式: {"cases":[{"id":"短い英数字","title":"事件タイトル","difficulty":"低|中|高","atmosphere":"雰囲気","summary":"80字以内の概要"}]}',
        ].join('\n'),
        'start-case': [
            '選ばれた事件候補から、完全な事件ファイルを生成してください。',
            'JSON形式: {"case":{"id":"","title":"","difficulty":"","atmosphere":"","summary":"","location":"","truth":{"culprit":"","motive":"","trick":"","decisiveEvidence":""},"people":[{"id":"","name":"","role":"","note":"","suspicion":1}],"evidence":[{"id":"","name":"","type":"","detail":"","importance":1}],"testimonies":[{"id":"","speaker":"","claim":"","detail":""}],"opening":"事件開始時の描写","status":"初動捜査中"}}',
            `選択候補: ${compactOption}`,
        ].join('\n'),
        turn: [
            'プレイヤーの行動またはミニゲーム結果を受けて、事件を1段階進めてください。',
            '成功でも失敗でも解決可能にし、有利不利ではなく展開の方向性を変えてください。',
            'JSON形式: {"update":{"title":"","narrative":"180字以内","status":"","newEvidence":[{"id":"","name":"","type":"","detail":"","importance":1}],"newTestimonies":[{"id":"","speaker":"","claim":"","detail":""}],"newPeople":[{"id":"","name":"","role":"","note":"","suspicion":1}],"currentDeduction":"現在の推理状況の短い整理"}}',
            `現在状態: ${compactState}`,
            `ミニゲーム: ${compactMiniGame}`,
            `結果: ${compactResult}`,
        ].join('\n'),
        minigame: [
            '指定されたミニゲーム用の問題データだけを生成してください。ゲーム本体は固定です。',
            'timeline: {"task":{"cards":[{"id":"","text":"","order":1}],"timeLimit":30,"brief":""}}',
            'laser: {"task":{"targets":[{"id":"","name":"","kind":"","x":10,"y":20}],"timeLimit":25,"brief":""}}',
            'tailing: {"task":{"suspect":"","place":"商店街|夜の公園|港|地下街|オフィス街|夜道","situation":"","idealMin":200,"idealMax":350,"tooClose":150,"tooFar":500,"timeLimit":60}}',
            'lab: {"task":{"items":[{"id":"","name":"","sample":""}],"sequence":["id1","id2","id3","id4"],"brief":""}}',
            'lock: {"task":{"target":"","digits":4,"password":["A","B","C","D"],"symbols":["A","B","C","D","E","F"],"brief":""}}',
            `種類: ${compactMiniGame}`,
            `現在状態: ${compactState}`,
        ].join('\n'),
        final: [
            'これまでの全証拠、全証言、全容疑者、全ターン履歴、ミニゲーム結果に整合する最終推理問題を生成してください。',
            '必ず既存の真相を変えず、選択肢は紛らわしいが矛盾しない範囲にしてください。',
            'JSON形式: {"final":{"culprits":[""],"motives":[""],"tricks":[""],"evidence":[""],"answer":{"culprit":"","motive":"","trick":"","evidence":""},"explanation":"真相説明"}}',
            `現在状態: ${compactState}`,
        ].join('\n'),
    };

    return `${common}\n\n${schemas[action] || schemas.turn}`;
}

function fallbackDetectivePayload(action, payload) {
    const seed = String(payload.generation?.requestId || Date.now().toString(36)).replace(/[^a-z0-9]/gi, '').slice(-8) || Date.now().toString(36).slice(-5);
    if (action === 'case-options') {
        const previousTitles = new Set(Array.isArray(payload.generation?.previousTitles) ? payload.generation.previousTitles : []);
        const allFallbackCases = [
            { tag: 'observatory', title: '星図にない十三番目の光', difficulty: '中', atmosphere: '閉館後の天文台、冷えた真鍮、曇ったドーム', summary: '公開前の星図に存在しない光点が現れ、観測主任の記録だけが一晩分抜け落ちた。' },
            { tag: 'laundry', title: '白手袋だけが濡れている', difficulty: '低', atmosphere: '地下ランドリー、洗剤の匂い、非常灯の赤', summary: '乾燥室で見つかった白手袋だけが濡れ、持ち主のロッカーには別人の鍵が残された。' },
            { tag: 'theater', title: '拍手の後に消えた台本', difficulty: '高', atmosphere: '古い小劇場、埃をかぶった幕、割れたスポットライト', summary: '千秋楽の拍手が止んだ直後、犯行を予告する台本だけが楽屋から消えた。' },
            { tag: 'clinic', title: '眠らない診察券', difficulty: '中', atmosphere: '深夜診療所、薬品棚、雨に濡れた待合室', summary: '閉院後の受付端末で、存在しない患者の診察券が何度も呼び出された。' },
            { tag: 'aquarium', title: '水槽に沈んだ暗号', difficulty: '高', atmosphere: '無人の水族館、青い照明、濡れた床', summary: '大型水槽の底に暗号カードが沈み、監視員全員の巡回時刻が食い違う。' },
            { tag: 'bakery', title: '焼き印のない招待状', difficulty: '低', atmosphere: '朝前のベーカリー、焦げた砂糖、閉じた裏口', summary: '限定パンの焼き印だけが消え、代わりに未配達の招待状が窯の横で見つかった。' },
            { tag: 'radio', title: '雑音が告げた不在証明', difficulty: '中', atmosphere: '古いラジオ局、深夜放送、擦れた磁気テープ', summary: '生放送中の雑音に容疑者の声が混じるが、本人は同時刻に別室で録画されていた。' },
            { tag: 'museum', title: '額縁だけが覚えている', difficulty: '高', atmosphere: '改装中の美術館、木くず、黒い展示布', summary: '盗まれた絵の痕跡はなく、額縁の裏にだけ当日とは違う日付が刻まれていた。' },
            { tag: 'station', title: '終電後の切符番号', difficulty: '中', atmosphere: '無人駅、濡れたホーム、青い券売機', summary: '終電後に発券された切符が事件現場に残り、券売機の履歴だけが逆順になっていた。' },
        ];
        const pool = allFallbackCases.filter((item) => !previousTitles.has(item.title));
        const source = pool.length >= 3 ? pool : allFallbackCases;
        const offset = seed.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % source.length;
        const selected = [...source.slice(offset), ...source.slice(0, offset)].slice(0, 3);
        return {
            cases: selected.map((item, index) => ({
                id: `${item.tag}-${seed}-${index}`,
                title: item.title,
                difficulty: item.difficulty,
                atmosphere: item.atmosphere,
                summary: item.summary,
            })),
        };
    }

    if (action === 'start-case') {
        const option = payload.option || {};
        return buildFallbackCase(option, seed);
    }

    if (action === 'minigame') {
        return buildFallbackMiniGame(payload.miniGame?.type || 'timeline', payload.state || {});
    }

    if (action === 'final') {
        const game = payload.state || {};
        const truth = game.truth || {};
        const people = Array.isArray(game.people) ? game.people.map((p) => p.name).filter(Boolean) : [];
        const evidence = Array.isArray(game.evidence) ? game.evidence.map((e) => e.name).filter(Boolean) : [];
        return {
            final: {
                culprits: unique([truth.culprit, ...people]).slice(0, 4),
                motives: unique([truth.motive, '保身のため記録を隠したかった', '誰かをかばうため時刻をずらした']).slice(0, 4),
                tricks: unique([truth.trick, '停電中に証拠を移動した', '監視ログの死角を利用した']).slice(0, 4),
                evidence: unique([truth.decisiveEvidence, ...evidence]).slice(0, 5),
                answer: {
                    culprit: truth.culprit,
                    motive: truth.motive,
                    trick: truth.trick,
                    evidence: truth.decisiveEvidence,
                },
                explanation: `${truth.culprit}は${truth.motive}。${truth.trick}ことで疑いをそらしたが、${truth.decisiveEvidence}が決め手になった。`,
            },
        };
    }

    const turn = Number(payload.state?.turn || 1);
    return {
        update: {
            title: `捜査記録 ${turn}`,
            narrative: turn % 2
                ? '雨音の奥から、証言の時刻をずらす小さなノイズが浮かび上がった。失敗に見えた調査も、別の人物の動線を照らしている。'
                : '現場の空気が少し変わった。新しい物証は派手ではないが、既存の証言と並べると一つだけ沈黙が重くなる。',
            status: turn >= 3 ? '最終推理可能' : '捜査継続',
            newEvidence: [{ id: `ev-${seed}-${turn}`, name: `濡れた封筒片 ${turn}`, type: '物証', detail: '机の下から見つかった封筒片。差出人の筆跡と同じインクがにじんでいる。', importance: 2 }],
            newTestimonies: [{ id: `ts-${seed}-${turn}`, speaker: '夜勤警備員・相良', claim: '問題の時刻、廊下の足音は一人分ではありませんでした。', detail: '足音は一度だけ展示室の前で止まっている。' }],
            newPeople: turn === 2 ? [{ id: `pe-${seed}`, name: '夜勤警備員・相良', role: '警備員', note: '監視ログの管理者', suspicion: 2 }] : [],
            currentDeduction: '時刻、動線、濡れた紙片の三点を並べると、犯人は現場に戻った可能性が高い。',
        },
    };
}

function buildFallbackCase(option, seed) {
    const title = option.title || '雨粒が消した署名';
    return {
        case: {
            id: option.id || `case-${seed}`,
            title,
            difficulty: option.difficulty || '中',
            atmosphere: option.atmosphere || '雨夜のノワール',
            summary: option.summary || '消えた署名と食い違う証言を追う事件。',
            location: '深夜の銀座・小さな画廊',
            truth: {
                culprit: '画廊助手・真壁レイ',
                motive: '偽造契約が発覚する前に原本を無効にしたかった',
                trick: '加湿器に混ぜた特殊インク溶剤で署名だけをにじませた',
                decisiveEvidence: '加湿器フィルターの青黒い沈殿',
            },
            people: [
                { id: 'p-rei', name: '画廊助手・真壁レイ', role: '助手', note: '契約書を最後に保管した人物', suspicion: 3 },
                { id: 'p-owner', name: '画廊主・久世', role: '依頼人', note: '署名消失を最初に発見', suspicion: 1 },
                { id: 'p-guard', name: '夜勤警備員・相良', role: '警備員', note: '監視ログを確認した', suspicion: 2 },
            ],
            evidence: [
                { id: 'ev-contract', name: '署名だけ消えた契約書', type: '書類', detail: '本文は無事だが署名欄だけが青黒くにじんで読めない。', importance: 3 },
                { id: 'ev-filter', name: '加湿器フィルターの青黒い沈殿', type: '鑑識', detail: '署名インクと同じ成分がフィルターから検出された。', importance: 3 },
            ],
            testimonies: [
                { id: 'ts-rei', speaker: '画廊助手・真壁レイ', claim: '私は契約書に触っていません。閉館後は照明を落としただけです。', detail: '加湿器の交換には触れていないと主張。' },
                { id: 'ts-owner', speaker: '画廊主・久世', claim: '署名は閉館前には確かにありました。', detail: '契約書はデスクの上に置かれていた。' },
            ],
            opening: `${title}。雨の夜、画廊の奥で契約書から署名だけが消えた。紙は破れていない。だが空気だけが妙に湿っている。`,
            status: '初動捜査中',
        },
    };
}

function buildFallbackMiniGame(type, state) {
    const evidenceName = state?.evidence?.[0]?.name || '署名だけ消えた契約書';
    if (type === 'laser') {
        return { task: { brief: 'レーザーで痕跡を照射し、全証拠を浮かび上がらせる。', timeLimit: 24, targets: [
            { id: 'l1', name: '青黒い沈殿', kind: '化学痕', x: 18, y: 24 },
            { id: 'l2', name: '濡れた指紋', kind: '指紋', x: 68, y: 38 },
            { id: 'l3', name: '紙繊維', kind: '繊維', x: 44, y: 72 },
        ] } };
    }
    if (type === 'tailing') {
        return { task: { suspect: '画廊助手・真壁レイ', place: '雨の銀座裏通り', situation: '閉館後、レイは人気の少ない裏通りへ向かっている。', idealMin: 200, idealMax: 350, tooClose: 150, tooFar: 500, timeLimit: 60 } };
    }
    if (type === 'lab') {
        return { task: { brief: `${evidenceName}の成分を順番に分析する。`, items: [
            { id: 'a', name: 'ルミノール', sample: '紙片' },
            { id: 'b', name: 'インク試薬', sample: '署名欄' },
            { id: 'c', name: '湿度反応', sample: 'フィルター' },
            { id: 'd', name: 'DNA綿棒', sample: '封筒' },
        ], sequence: ['b', 'c', 'a', 'd'] } };
    }
    if (type === 'lock') {
        return { task: { target: '画廊のノートPC', digits: 4, symbols: ['A', 'B', 'C', 'D', 'E', 'F'], password: ['C', 'A', 'E', 'B'], brief: '監視ログへアクセスする。' } };
    }
    return { task: { brief: '出来事を正しい順序へ復元する。', timeLimit: 32, cards: [
        { id: 't1', text: '閉館前に署名を確認', order: 1 },
        { id: 't2', text: '加湿器が強く作動', order: 2 },
        { id: 't3', text: '署名欄がにじむ', order: 3 },
        { id: 't4', text: '画廊主が消失に気づく', order: 4 },
        { id: 't5', text: '警備ログを確認', order: 5 },
    ] } };
}

function unique(items) {
    return [...new Set(items.filter(Boolean))];
}

function withTimeout(promise, timeoutMs, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
