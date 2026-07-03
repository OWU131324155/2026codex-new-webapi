const express = require('express');
const fs = require('fs');
const path = require('path');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public'));

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

// public/ 内の .html 一覧を返す（index.html がこの一覧を使ってリンクを表示する）
app.get('/api/pages', (req, res) => {
    const files = fs.readdirSync('public')
        .filter(name => name.endsWith('.html') && name !== 'index.html');
    res.json(files);
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

    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
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
    const responseText = data.choices[0].message.content;
    return extractArray(responseText);
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

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
