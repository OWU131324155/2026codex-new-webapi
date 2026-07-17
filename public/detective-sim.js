(() => {
    const gameEl = document.getElementById('detectiveGame');
    const activeCaseLabel = document.getElementById('activeCaseLabel');
    const actionGrid = document.getElementById('actionGrid');
    const boardPane = document.getElementById('boardPane');
    const peopleList = document.getElementById('peopleList');
    const historyRail = document.getElementById('historyRail');
    const miniModal = document.getElementById('minigameModal');
    const miniBody = document.getElementById('miniBody');
    const miniTimer = document.getElementById('miniTimer');
    const finalModal = document.getElementById('finalModal');
    const finalResult = document.getElementById('finalResult');
    const resultModal = document.getElementById('caseResultModal');
    const loadingEl = document.getElementById('gameLoading');
    const loadingTitle = document.getElementById('loadingTitle');
    const loadingText = document.getElementById('loadingText');
    const coachBubble = document.getElementById('coachBubble');
    const miniTypes = ['timeline', 'laser', 'tailing', 'lab', 'lock'];
    let boardTab = 'evidence';
    let finalData = null;
    let timerId = 0;
    let idleTimerId = 0;
    let timerDial = null;
    let cleanupMini = () => {};
    let coachIndex = 0;
    let miniResolved = false;
    const achievementStorageKey = 'detectiveAchievementCollection';
    const caseArchiveStorageKey = 'detectiveSolvedCaseArchive';
    const achievementDefinitions = [
        { id: 'case-clear-1', icon: '🏆', name: '初事件解決', description: '初めて事件を解決した', lockedDescription: '初めて事件を解決する', stat: 'caseClears', threshold: 1 },
        { id: 'case-clear-3', icon: '🏆', name: 'ベテラン探偵', description: '事件を3回解決した', lockedDescription: '事件を3回解決する', stat: 'caseClears', threshold: 3 },
        { id: 'case-clear-10', icon: '🏆', name: '名探偵', description: '事件を10回解決した', lockedDescription: '事件を10回解決する', stat: 'caseClears', threshold: 10 },
        { id: 'mini-success-1', icon: '🔎', name: 'はじめての捜査', description: 'ミニゲームに初めて成功した', lockedDescription: 'ミニゲームに初めて成功する', stat: 'miniSuccesses', threshold: 1 },
        { id: 'mini-success-3', icon: '🔎', name: '捜査の達人', description: 'ミニゲームに3回成功した', lockedDescription: 'ミニゲームに3回成功する', stat: 'miniSuccesses', threshold: 3 },
        { id: 'mini-success-5', icon: '💎', name: '完璧な捜査', description: 'ミニゲームに5回成功した', lockedDescription: 'ミニゲームに5回成功する', stat: 'miniSuccesses', threshold: 5 },
        { id: 'mini-fail-1', icon: '🕯️', name: '次はうまくいく', description: 'ミニゲームに初めて失敗した', lockedDescription: 'ミニゲームに初めて失敗する', stat: 'miniFailures', threshold: 1 },
        { id: 'mini-fail-3', icon: '🕯️', name: 'あきらめない探偵', description: 'ミニゲームに3回失敗した', lockedDescription: 'ミニゲームに3回失敗する', stat: 'miniFailures', threshold: 3 },
        { id: 'mini-fail-5', icon: '📁', name: '失敗は成功の母', description: 'ミニゲームに5回失敗した', lockedDescription: 'ミニゲームに5回失敗する', stat: 'miniFailures', threshold: 5 },
    ];
    const achievementState = loadAchievements();

    const state = {
        loading: false,
        active: false,
        solved: false,
        turn: 0,
        case: null,
        truth: null,
        people: [],
        evidence: [],
        testimonies: [],
        history: [],
        miniResults: [],
        currentDeduction: '',
        offeredMinis: [],
        lastOfferedMinis: [],
        onboardingSeen: false,
        archiveRecorded: false,
    };
    window.detectiveSimState = state;
    window.detectiveSim = {
        hasActiveCase: () => Boolean(state.case && !state.solved),
        resumeCase,
        abandonCase,
        getOfficeSummary,
    };
    window.detectiveAchievements = {
        definitions: achievementDefinitions,
        getState: () => ({ ...achievementState, unlocked: [...achievementState.unlocked] }),
        getSnapshot: () => getAchievementSnapshot(),
        isDebugEnabled: () => new URLSearchParams(window.location.search).has('debugAchievements'),
        debugRecord: (stat) => {
            if (!new URLSearchParams(window.location.search).has('debugAchievements')) return;
            if (!['caseClears', 'miniSuccesses', 'miniFailures'].includes(stat)) return;
            recordAchievementProgress(stat);
        },
        debugReset: () => {
            if (!new URLSearchParams(window.location.search).has('debugAchievements')) return;
            achievementState.unlocked = [];
            achievementState.caseClears = 0;
            achievementState.miniSuccesses = 0;
            achievementState.miniFailures = 0;
            saveAchievements();
        },
    };
    window.detectiveArchive = {
        getEntries: () => loadCaseArchive(),
        getEntry: (id) => loadCaseArchive().find((entry) => entry.id === id) || null,
    };

    window.addEventListener('detective:start-case', (event) => {
        startCase(event.detail || {});
    });

    document.getElementById('gameBackOfficeBtn')?.addEventListener('click', returnToOffice);
    document.getElementById('resultBackOfficeBtn')?.addEventListener('click', () => {
        resultModal.classList.add('hidden');
        returnToOffice();
    });
    document.getElementById('finalCloseBtn')?.addEventListener('click', () => finalModal.classList.add('hidden'));
    document.getElementById('submitFinalBtn')?.addEventListener('click', submitFinal);
    document.getElementById('coachNextBtn')?.addEventListener('click', nextCoachStep);
    document.querySelectorAll('.board-tab').forEach((button) => {
        button.addEventListener('click', () => {
            boardTab = button.dataset.boardTab;
            document.querySelectorAll('.board-tab').forEach((item) => item.classList.toggle('active', item === button));
            renderBoard();
        });
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !document.body.classList.contains('detective-case-active')) return;
        if (!miniModal.classList.contains('hidden')) return;
        if (!finalModal.classList.contains('hidden')) {
            finalModal.classList.add('hidden');
            return;
        }
        if (!resultModal.classList.contains('hidden')) {
            resultModal.classList.add('hidden');
            returnToOffice();
            return;
        }
        returnToOffice();
    });

    async function startCase(option) {
        showGame();
        resetState();
        renderOpeningSkeleton(option);
        setLoading(true, '事件生成中', '犯人、動機、トリック、証拠を組み立てています。');
        try {
            const payload = await api('start-case', { option });
            const file = payload.case;
            state.active = true;
            state.case = file;
            state.truth = file.truth;
            state.turn = 1;
            addUnique(state.people, file.people, 'id');
            addUnique(state.evidence, file.evidence, 'id');
            addUnique(state.testimonies, file.testimonies, 'id');
            state.history.push({ title: '事件受注', text: file.opening });
            state.currentDeduction = '初動確認中。まずは聞き込みか現場捜査で情報を増やす。';
            rollMinis();
            render();
            startCoach();
        } catch (error) {
            state.history.push({ title: '通信失敗', text: formatError(error) });
            render();
        } finally {
            setLoading(false);
        }
    }

    function resetState() {
        state.loading = false;
        state.active = false;
        state.solved = false;
        state.turn = 0;
        state.case = null;
        state.truth = null;
        state.people = [];
        state.evidence = [];
        state.testimonies = [];
        state.history = [];
        state.miniResults = [];
        state.currentDeduction = '';
        state.offeredMinis = [];
        state.lastOfferedMinis = [];
        state.archiveRecorded = false;
        finalData = null;
    }

    function resumeCase() {
        if (!state.case) return false;
        showGame();
        render();
        return true;
    }

    function abandonCase() {
        resetState();
        updateOfficeSummary();
        render();
    }

    function getOfficeSummary() {
        if (!state.case) return { active: false, label: '未受注' };
        return {
            active: !state.solved,
            label: `${state.case.title} / Turn ${state.turn}`,
            title: state.case.title,
            turn: state.turn,
            status: state.solved ? '解決済み' : (state.case.status || '捜査中'),
        };
    }

    function showGame() {
        document.body.classList.add('detective-case-active');
        gameEl.classList.remove('hidden');
    }

    function returnToOffice() {
        document.body.classList.remove('detective-case-active');
        gameEl.classList.add('hidden');
        window.dispatchEvent(new CustomEvent('office:return-from-case'));
        updateOfficeSummary();
    }

    function renderOpeningSkeleton(option) {
        document.getElementById('gameCaseTitle').textContent = option.title || '事件生成中';
        document.getElementById('gameStatusLabel').textContent = 'AI生成中';
        document.getElementById('sceneHeadline').textContent = '事件ファイル展開中';
        document.getElementById('sceneNarrative').textContent = option.summary || 'OpenAI APIが新しい事件を生成しています。';
        document.getElementById('currentDeduction').textContent = '生成完了まで少し待ってください。';
    }

    function render() {
        const file = state.case || {};
        document.getElementById('gameCaseTitle').textContent = file.title || '事件未選択';
        document.getElementById('gameTurnLabel').textContent = `Turn ${state.turn}`;
        document.getElementById('gameStatusLabel').textContent = file.status || (state.turn >= 4 ? '最終推理可能' : '捜査中');
        document.getElementById('gameLocation').textContent = file.location || '現場未確定';
        document.getElementById('gameSummary').textContent = file.summary || '';
        document.getElementById('evidenceCount').textContent = state.evidence.length;
        document.getElementById('testimonyCount').textContent = state.testimonies.length;
        document.getElementById('peopleCount').textContent = state.people.length;
        document.getElementById('miniCount').textContent = state.miniResults.length;

        const latest = state.history[state.history.length - 1] || {};
        document.getElementById('sceneKicker').textContent = state.turn >= 4 ? 'Final Ready' : 'Investigation';
        document.getElementById('sceneHeadline').textContent = latest.title || file.title || '事件開始';
        document.getElementById('sceneNarrative').textContent = latest.text || file.opening || '事件を読み込み中です。';
        document.getElementById('currentDeduction').textContent = state.currentDeduction || '今の推理はまだ白紙です。';
        renderPeople();
        renderBoard();
        renderHistory();
        renderActions();
        resetIdleHint();
        updateOfficeSummary();
    }

    function updateOfficeSummary() {
        const summary = getOfficeSummary();
        if (activeCaseLabel) activeCaseLabel.textContent = summary.label;
        window.dispatchEvent(new CustomEvent('detective:state-change', { detail: summary }));
    }

    function renderPeople() {
        peopleList.innerHTML = '';
        state.people.forEach((person) => {
            const card = document.createElement('article');
            card.className = 'person-chip';
            card.innerHTML = `<strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(person.role || '関係者')}</span>`;
            peopleList.appendChild(card);
        });
    }

    function renderBoard() {
        boardPane.innerHTML = '';
        const items = boardTab === 'evidence' ? state.evidence : boardTab === 'testimony' ? state.testimonies : state.miniResults;
        if (!items.length) {
            boardPane.innerHTML = '<article class="board-item"><strong>未取得</strong><p>まだカードはありません。</p></article>';
            return;
        }
        items.forEach((item) => {
            const card = document.createElement('article');
            card.className = 'board-item';
            if (boardTab === 'testimony') {
                card.innerHTML = `<strong>${escapeHtml(item.speaker)}</strong><span>証言</span><p>${escapeHtml(item.claim || item.detail || '')}</p>`;
            } else if (boardTab === 'mini') {
                card.innerHTML = `<strong>${escapeHtml(labelMini(item.type))}: ${item.success ? '成功' : '失敗'}</strong><span>Turn ${item.turn} / ${escapeHtml(item.grade || 'Result')}</span><p>${escapeHtml(item.summary)}</p>`;
            } else {
                card.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.type || '証拠')}</span><p>${escapeHtml(item.detail || '')}</p>`;
            }
            boardPane.appendChild(card);
        });
    }

    function renderHistory() {
        historyRail.innerHTML = '';
        state.history.slice(-5).forEach((item, index) => {
            const row = document.createElement('article');
            row.className = 'history-item';
            row.innerHTML = `<strong>${index + 1}. ${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p>`;
            historyRail.appendChild(row);
        });
    }

    function renderActions() {
        window.clearTimeout(idleTimerId);
        actionGrid.innerHTML = '';
        addAction('聞き込み', '新情報をAI生成', () => runTalk());
        state.offeredMinis.forEach((type) => {
            addAction(labelMini(type), miniCatch(type), () => runMini(type));
        });
        addAction('最終推理', state.turn >= 4 ? '解決へ進む' : 'Turn 4で解放', () => openFinal(), state.turn < 4);
    }

    function addAction(title, text, handler, disabled = false) {
        const button = document.createElement('button');
        button.className = 'action-card';
        button.type = 'button';
        button.disabled = disabled || state.loading;
        button.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span>`;
        button.addEventListener('click', handler);
        actionGrid.appendChild(button);
    }

    async function runTalk() {
        await applyTurn({ type: 'talk', label: '聞き込み', success: true, grade: 'Info', summary: '関係者の話から新しい違和感を拾った。' });
    }

    async function runMini(type) {
        setLoading(true, 'ミニゲーム生成中', `${labelMini(type)}の問題だけを事件内容に合わせています。`);
        try {
            const payload = await api('minigame', { miniGame: { type }, state: publicState() });
            openMini(type, payload.task || {});
        } catch (error) {
            openMini(type, fallbackMiniTask(type, state));
        } finally {
            setLoading(false);
        }
    }

    async function applyTurn(result) {
        setLoading(true, '事件展開生成中', '今回の行動結果を物語に反映しています。');
        if (result.type !== 'talk') {
            state.miniResults.push({ ...result, turn: state.turn });
        }
        try {
            const payload = await api('turn', {
                state: publicState(),
                miniGame: { type: result.type, label: result.label },
                result,
            });
            const update = payload.update || {};
            addUnique(state.evidence, update.newEvidence, 'id');
            addUnique(state.testimonies, update.newTestimonies, 'id');
            addUnique(state.people, update.newPeople, 'id');
            state.currentDeduction = update.currentDeduction || state.currentDeduction;
            state.history.push({
                title: update.title || result.label,
                text: update.narrative || result.summary,
            });
            state.turn += 1;
            if (state.case) state.case.status = update.status || state.case.status;
            rollMinis();
            render();
        } catch (error) {
            state.history.push({ title: result.label, text: result.summary || formatError(error) });
            state.turn += 1;
            rollMinis();
            render();
        } finally {
            setLoading(false);
            closeMini();
        }
    }

    function rollMinis() {
        let pool = miniTypes.filter((type) => !state.lastOfferedMinis.includes(type));
        if (pool.length < 2) pool = [...miniTypes];
        const shuffled = pool.sort(() => Math.random() - 0.5);
        state.offeredMinis = shuffled.slice(0, 2);
        state.lastOfferedMinis = [...state.offeredMinis];
    }

    function openMini(type, task) {
        cleanupMini();
        cleanupMini = () => {};
        miniResolved = false;
        document.getElementById('miniTypeLabel').textContent = labelMini(type);
        document.getElementById('miniTitle').textContent = task.brief || describeMini(type);
        miniModal.classList.remove('hidden');
        renderMiniRules(type, task);
    }

    function renderMiniRules(type, task) {
        const rules = ruleText(type, task);
        const displaySeconds = type === 'tailing' ? rules.seconds : (task.timeLimit || rules.seconds);
        miniBody.innerHTML = `
            <div class="mini-rules">
                <span class="hud-kicker">${escapeHtml(labelMini(type))}</span>
                <strong>${escapeHtml(rules.title)}</strong>
                <p>${escapeHtml(rules.body)}</p>
                <div class="rule-chips">
                    <span>成功: ${escapeHtml(rules.success)}</span>
                    <span>失敗: ${escapeHtml(rules.failure)}</span>
                    <span>制限時間: ${displaySeconds}秒</span>
                </div>
                <div class="actions">
                    <button class="hub-button primary" data-mini-start type="button">スタート</button>
                    <button class="surrender-btn" data-mini-giveup type="button">撤退して進める</button>
                </div>
            </div>
        `;
        miniTimer.textContent = '--';
        miniBody.querySelector('[data-mini-start]').addEventListener('click', () => startMini(type, task));
        miniBody.querySelector('[data-mini-giveup]').addEventListener('click', () => finishMini(type, false, '撤退を選び、別方向から事件を進めた。', 'Withdraw'));
    }

    function startMini(type, task) {
        window.clearTimeout(idleTimerId);
        miniBody.innerHTML = miniHud(type, task);
        miniBody.querySelector('[data-mini-giveup]').addEventListener('click', () => finishMini(type, false, '撤退を選び、調査は別ルートへ切り替わった。', 'Withdraw'));
        timerDial = miniBody.querySelector('.timer-dial');
        if (type === 'timeline') renderTimeline(task);
        if (type === 'laser') renderLaser(task);
        if (type === 'tailing') renderTailing(task);
        if (type === 'lab') renderLab(task);
        if (type === 'lock') renderLock(task);
    }

    function miniHud(type, task) {
        return `
            <div class="mini-hud">
                <div class="timer-dial" style="--time: 100"><strong>--</strong><span>TIME</span></div>
                <div class="mini-goal"><strong>${escapeHtml(labelMini(type))}</strong><span>${escapeHtml(type === 'tailing' ? describeMini(type) : (task.brief || describeMini(type)))}</span></div>
                <button class="surrender-btn" data-mini-giveup type="button">撤退</button>
            </div>
            <div class="mini-playfield" data-playfield></div>
        `;
    }

    function startTimer(seconds, onEnd) {
        window.clearInterval(timerId);
        const total = Math.max(1, seconds);
        let left = total;
        paintTimer(left, total);
        timerId = window.setInterval(() => {
            left -= 1;
            paintTimer(left, total);
            if (left <= 0) {
                window.clearInterval(timerId);
                onEnd();
            }
        }, 1000);
    }

    function paintTimer(left, total) {
        const safeLeft = Math.max(0, left);
        miniTimer.textContent = `${safeLeft}s`;
        if (timerDial) {
            timerDial.style.setProperty('--time', String((safeLeft / total) * 100));
            timerDial.querySelector('strong').textContent = String(safeLeft);
        }
    }

    function finishMini(type, success, summary, grade = '') {
        if (miniResolved) return;
        miniResolved = true;
        window.clearInterval(timerId);
        cleanupMini();
        cleanupMini = () => {};
        recordAchievementProgress(success ? 'miniSuccesses' : 'miniFailures');
        showMiniResult({ type, label: labelMini(type), success, summary, grade: grade || (success ? 'Clear' : 'Miss') });
    }

    function showMiniResult(result) {
        miniTimer.textContent = result.success ? 'CLEAR' : 'MISS';
        miniBody.innerHTML = `
            <div class="mini-result ${result.success ? 'success' : 'fail'}">
                <span class="hud-kicker">${escapeHtml(result.label)}</span>
                <strong>${result.success ? '成功' : '失敗'}</strong>
                <p>${escapeHtml(result.summary)}</p>
                <button class="hub-button primary" data-mini-next type="button">事件を進める</button>
            </div>
        `;
        miniBody.querySelector('[data-mini-next]').addEventListener('click', () => applyTurn(result));
    }

    function expandLaserTargets(baseTargets) {
        const names = baseTargets.length ? baseTargets : fallbackMiniTask('laser').targets;
        const rows = [18, 30, 42, 54];
        const expanded = [];
        for (let i = 0; i < 16; i += 1) {
            const source = names[i % names.length];
            expanded.push({
                id: `${source.id || 'target'}-${i}`,
                name: source.name || source.kind || '痕跡',
                x: 12 + (i % 4) * 23,
                y: rows[Math.floor(i / 4)],
                vx: i % 2 ? 0.12 : -0.12,
            });
        }
        return expanded;
    }

    function closeMini() {
        window.clearInterval(timerId);
        cleanupMini();
        cleanupMini = () => {};
        miniModal.classList.add('hidden');
    }

    function resetIdleHint() {
        window.clearTimeout(idleTimerId);
        if (!state.case || state.solved || !document.body.classList.contains('detective-case-active')) return;
        idleTimerId = window.setTimeout(() => {
            if (!state.case || state.solved || state.loading || !miniModal.classList.contains('hidden') || !finalModal.classList.contains('hidden')) return;
            coachIndex = 0;
            coachBubble.className = 'coach-bubble coach-right idle-hint';
            coachBubble.classList.remove('hidden');
            document.getElementById('coachTitle').textContent = '相棒AIの出番';
            document.getElementById('coachText').textContent = '迷ったら3D事務所のAI助手に戻って、証拠整理や次の一手を聞けます。メインデスクから事件は再開できます。';
        }, 45000);
    }

    function renderTimeline(task) {
        const cards = [...(task.cards || fallbackMiniTask('timeline').cards)].sort(() => Math.random() - 0.5);
        let selected = -1;
        const field = miniBody.querySelector('[data-playfield]');
        field.innerHTML = '<div class="timeline-list"></div><div class="actions"><button class="hub-button ghost" data-up>上へ</button><button class="hub-button ghost" data-down>下へ</button><button class="hub-button primary" data-submit>確定</button></div>';
        const list = field.querySelector('.timeline-list');
        const paint = () => {
            list.innerHTML = '';
            cards.forEach((card, index) => {
                const node = document.createElement('button');
                node.className = `timeline-card ${selected === index ? 'selected' : ''}`;
                node.type = 'button';
                node.innerHTML = `<span>${index + 1}</span> ${escapeHtml(card.text)}`;
                node.addEventListener('click', () => { selected = index; paint(); });
                list.appendChild(node);
            });
        };
        field.querySelector('[data-up]').addEventListener('click', () => {
            if (selected > 0) [cards[selected - 1], cards[selected]] = [cards[selected], cards[selected - 1]];
            selected = Math.max(0, selected - 1);
            paint();
        });
        field.querySelector('[data-down]').addEventListener('click', () => {
            if (selected >= 0 && selected < cards.length - 1) [cards[selected + 1], cards[selected]] = [cards[selected], cards[selected + 1]];
            selected = Math.min(cards.length - 1, selected + 1);
            paint();
        });
        field.querySelector('[data-submit]').addEventListener('click', () => {
            const correct = cards.filter((card, index) => Number(card.order) === index + 1).length;
            finishMini('timeline', correct >= cards.length - 1, `${correct}/${cards.length} の時系列を復元した。`, correct === cards.length ? 'Perfect' : 'Partial');
        });
        paint();
        startTimer(task.timeLimit || 40, () => finishMini('timeline', false, '時系列の確定前に時間切れになった。', 'Timeout'));
    }

    function renderLaser(task) {
        const baseTargets = task.targets || fallbackMiniTask('laser').targets;
        const targets = expandLaserTargets(baseTargets);
        const field = miniBody.querySelector('[data-playfield]');
        field.innerHTML = '<div class="laser-field"><i class="laser-player"></i></div><p class="laser-score">A/D または ←/→ で移動、Spaceでレーザー。残り <span data-left></span></p>';
        const laser = field.querySelector('.laser-field');
        const player = field.querySelector('.laser-player');
        const leftLabel = field.querySelector('[data-left]');
        let playerX = 50;
        let shots = [];
        let enemies = [];
        const keys = new Set();
        const keydown = (e) => {
            keys.add(e.key.toLowerCase());
            if (e.code === 'Space') {
                e.preventDefault();
                fireShot();
            }
        };
        const keyup = (e) => keys.delete(e.key.toLowerCase());
        document.addEventListener('keydown', keydown);
        document.addEventListener('keyup', keyup);
        targets.forEach((target) => {
            const node = document.createElement('i');
            node.className = 'laser-target';
            node.style.left = `${target.x}%`;
            node.style.top = `${target.y}%`;
            node.textContent = target.name;
            laser.appendChild(node);
            enemies.push({ node, x: target.x, y: target.y, vx: target.vx || 0.08 });
        });
        const fireShot = () => {
            if (shots.length > 3) return;
            const shot = document.createElement('i');
            shot.className = 'laser-shot';
            shot.style.left = `${playerX}%`;
            shot.style.bottom = '42px';
            laser.appendChild(shot);
            shots.push({ node: shot, x: playerX, y: 42 });
        };
        const loop = window.setInterval(() => {
            if (keys.has('arrowleft') || keys.has('a')) playerX -= 1.8;
            if (keys.has('arrowright') || keys.has('d')) playerX += 1.8;
            playerX = clamp(playerX, 4, 96);
            player.style.left = `${playerX}%`;
            enemies.forEach((enemy) => {
                enemy.x += enemy.vx;
                if (enemy.x > 94 || enemy.x < 6) enemy.vx *= -1;
                enemy.node.style.left = `${enemy.x}%`;
            });
            shots.forEach((shot) => {
                shot.y += 4.8;
                shot.node.style.bottom = `${shot.y}px`;
            });
            shots = shots.filter((shot) => {
                if (shot.y > laser.clientHeight) {
                    shot.node.remove();
                    return false;
                }
                return true;
            });
            enemies = enemies.filter((enemy) => {
                const hit = shots.find((shot) => {
                    const shotY = laser.clientHeight - shot.y;
                    const enemyY = laser.clientHeight * (enemy.y / 100);
                    const enemyX = laser.clientWidth * (enemy.x / 100);
                    const shotX = laser.clientWidth * (shot.x / 100);
                    return Math.abs(shotX - enemyX) < 36 && Math.abs(shotY - enemyY) < 28;
                });
                if (hit) {
                    hit.node.remove();
                    enemy.node.remove();
                    shots = shots.filter((shot) => shot !== hit);
                    return false;
                }
                return true;
            });
            leftLabel.textContent = String(enemies.length);
            if (!enemies.length) finishMini('laser', true, '全ターゲットを撃破し、鑑識データを確保した。', 'All Clear');
        }, 40);
        cleanupMini = () => {
            window.clearInterval(loop);
            document.removeEventListener('keydown', keydown);
            document.removeEventListener('keyup', keyup);
        };
        leftLabel.textContent = String(enemies.length);
        startTimer(task.timeLimit || 36, () => finishMini('laser', enemies.length <= 2, enemies.length <= 2 ? 'ほぼ全ての痕跡を撃ち抜いた。' : '痕跡の取り逃しが残った。', `${targets.length - enemies.length}/${targets.length}`));
    }

    function renderTailing(task) {
        const field = miniBody.querySelector('[data-playfield]');
        const config = {
            suspect: task.suspect || '容疑者',
            place: task.place || '夜道',
            situation: task.situation || '容疑者が人気の少ない道へ向かっている。',
            idealMin: Number(task.idealMin || 200),
            idealMax: Number(task.idealMax || 350),
            tooClose: Number(task.tooClose || 150),
            tooFar: Number(task.tooFar || 500),
            timeLimit: 20,
        };
        if (config.idealMin < 100 || config.idealMax < 160) {
            config.idealMin = 200;
            config.idealMax = 350;
            config.tooClose = 150;
            config.tooFar = 500;
        }
        field.innerHTML = `
            <div class="tailing-mission">
                <strong>${escapeHtml(config.suspect)}を尾行せよ</strong>
                <span>${escapeHtml(config.place)} / 20秒間、近すぎず遠すぎず追跡</span>
            </div>
            <div class="tailing-status">
                <div><span>警戒</span><b class="tailing-bar alert"><i data-alert></i></b></div>
                <div><span>見失い</span><b class="tailing-bar lost"><i data-lost></i></b></div>
                <div><span>距離</span><b class="tailing-distance" data-distance>--m</b></div>
            </div>
            <div class="tailing-range">
                <span>近い</span>
                <b><i data-range-marker></i></b>
                <span>遠い</span>
                <em data-range-state>適正</em>
            </div>
            <div class="tailing-track ${tailingPlaceClass(config.place)}">
                <i class="tailing-moon"></i>
                <i class="tailing-backlane"></i>
                <i class="tailing-suspect"><span>?</span></i>
                <i class="tailing-player"><span></span></i>
            </div>
            <p class="deduction-note">← → / A Dで走る速さを調整、Spaceでジャンプ。20秒間、容疑者との距離を保つ。</p>
        `;
        const suspect = field.querySelector('.tailing-suspect');
        const player = field.querySelector('.tailing-player');
        const track = field.querySelector('.tailing-track');
        const alertBar = field.querySelector('[data-alert]');
        const lostBar = field.querySelector('[data-lost]');
        const distanceLabel = field.querySelector('[data-distance]');
        const rangeMarker = field.querySelector('[data-range-marker]');
        const rangeState = field.querySelector('[data-range-state]');
        let playerWorld = 0;
        let suspectWorld = 280;
        let playerY = 0;
        let velocityY = 0;
        let speedOffset = 0;
        let alertGauge = 0;
        let lostGauge = 0;
        let scroll = 0;
        let stumbleUntil = 0;
        let jumpBoostUntil = 0;
        let grounded = true;
        let suspectAction = 'steady';
        let suspectActionUntil = 0;
        let suspectSpeedOffset = 0;
        let lastTime = performance.now();
        let frameId = 0;
        const obstacleTypes = [
            { kind: 'crate', label: '木箱', w: 42, h: 38 },
            { kind: 'cone', label: 'コーン', w: 30, h: 32 },
            { kind: 'bench', label: 'ベンチ', w: 86, h: 34 },
            { kind: 'gap', label: '穴', w: 74, h: 18 },
            { kind: 'step', label: '段差', w: 58, h: 46 },
        ];
        let obstacles = Array.from({ length: 24 }, (_, index) => ({
            x: 460 + index * 195 + (index % 4) * 38,
            ...obstacleTypes[index % obstacleTypes.length],
            hit: false,
            cleared: false,
            node: document.createElement('i'),
        }));
        obstacles.forEach((obstacle) => {
            obstacle.node.className = `tailing-obstacle obstacle-${obstacle.kind}`;
            obstacle.node.style.height = `${obstacle.h}px`;
            obstacle.node.style.width = `${obstacle.w}px`;
            obstacle.node.dataset.label = obstacle.label;
            track.appendChild(obstacle.node);
        });
        const keys = new Set();
        const keydown = (e) => {
            keys.add(e.key.toLowerCase());
            if (e.code === 'Space' && grounded && !e.repeat) {
                e.preventDefault();
                velocityY = 600;
                grounded = false;
            }
        };
        const keyup = (e) => keys.delete(e.key.toLowerCase());
        document.addEventListener('keydown', keydown);
        document.addEventListener('keyup', keyup);
        const loop = (now) => {
            const delta = Math.min(0.04, (now - lastTime) / 1000 || 0.016);
            lastTime = now;
            if (now > suspectActionUntil) {
                const roll = Math.random();
                if (roll < 0.18) {
                    suspectAction = 'lookback';
                    suspectSpeedOffset = -28;
                    suspectActionUntil = now + 650;
                } else if (roll < 0.38) {
                    suspectAction = 'slow';
                    suspectSpeedOffset = -22;
                    suspectActionUntil = now + 900;
                } else if (roll < 0.58) {
                    suspectAction = 'quick';
                    suspectSpeedOffset = 24;
                    suspectActionUntil = now + 850;
                } else if (roll < 0.68) {
                    suspectAction = 'pause';
                    suspectSpeedOffset = -84;
                    suspectActionUntil = now + 420;
                } else {
                    suspectAction = 'steady';
                    suspectSpeedOffset = 0;
                    suspectActionUntil = now + 1500 + Math.random() * 1200;
                }
            }
            const suspectSpeed = Math.max(70, 152 + suspectSpeedOffset);
            const stumble = now < stumbleUntil;
            const jumpBoost = now < jumpBoostUntil ? 24 : 0;
            const basePlayerSpeed = 152 * (stumble ? 0.58 : 1);
            const maxInputSpeed = 70;
            const response = 9;
            const input = (keys.has('arrowright') || keys.has('d') ? 1 : 0) - (keys.has('arrowleft') || keys.has('a') ? 1 : 0);
            const targetOffset = input * maxInputSpeed;
            speedOffset += (targetOffset - speedOffset) * Math.min(1, response * delta);
            suspectWorld += suspectSpeed * delta;
            playerWorld += (basePlayerSpeed + speedOffset + jumpBoost) * delta;
            velocityY -= 1800 * delta;
            const nextY = playerY + velocityY * delta;
            if (nextY <= 0) {
                playerY = 0;
                velocityY = 0;
                grounded = true;
            } else {
                playerY = nextY;
            }
            const distance = suspectWorld - playerWorld;
            const close = distance < config.tooClose;
            const far = distance > config.tooFar;
            const ideal = distance >= config.idealMin && distance <= config.idealMax;
            const idealCenter = (config.idealMin + config.idealMax) / 2;
            const playerScreen = clamp(150 + speedOffset * 0.52 - (distance - idealCenter) * 0.05, 110, 250);
            scroll = playerWorld - playerScreen;
            const obstacleHit = obstacles.find((obstacle) => {
                if (obstacle.hit) return false;
                const obstacleHeight = obstacle.kind === 'gap' ? 10 : obstacle.h;
                const playerBox = {
                    left: playerWorld + 5,
                    right: playerWorld + 33,
                    bottom: playerY,
                    top: playerY + 48,
                };
                const obstacleBox = {
                    left: obstacle.x,
                    right: obstacle.x + obstacle.w,
                    bottom: 0,
                    top: obstacleHeight,
                };
                return playerBox.left < obstacleBox.right
                    && playerBox.right > obstacleBox.left
                    && playerBox.bottom < obstacleBox.top
                    && playerBox.top > obstacleBox.bottom;
            });
            if (obstacleHit) {
                obstacleHit.hit = true;
                obstacleHit.node.classList.add('hit');
                stumbleUntil = now + 800;
            }
            obstacles.forEach((obstacle) => {
                if (obstacle.hit || obstacle.cleared || playerWorld <= obstacle.x + obstacle.w) return;
                if (playerY > obstacle.h - 8) {
                    obstacle.cleared = true;
                    obstacle.node.classList.add('cleared');
                    jumpBoostUntil = now + 420;
                    lostGauge -= 4;
                }
            });
            if (close) {
                alertGauge += (suspectAction === 'lookback' ? 42 : 24) * delta;
            } else if (ideal) {
                alertGauge -= 6 * delta;
            } else {
                alertGauge -= 3 * delta;
            }
            if (far) {
                lostGauge += 26 * delta;
            } else if (ideal) {
                lostGauge -= 6 * delta;
            } else {
                lostGauge -= 3 * delta;
            }
            alertGauge = clamp(alertGauge, 0, 100);
            lostGauge = clamp(lostGauge, 0, 100);
            suspect.classList.toggle('suspicious', close);
            suspect.classList.toggle('lookback', suspectAction === 'lookback');
            suspect.classList.toggle('quick', suspectAction === 'quick');
            suspect.classList.toggle('pause', suspectAction === 'pause');
            player.classList.toggle('stumble', stumble);
            player.classList.toggle('boost', now < jumpBoostUntil);
            track.classList.toggle('too-close', close);
            track.classList.toggle('too-far', far);
            track.classList.toggle('ideal-distance', ideal);
            track.style.setProperty('--scroll', `${-scroll}px`);
            suspect.style.left = `${suspectWorld - scroll}px`;
            suspect.style.bottom = '112px';
            player.style.left = `${playerWorld - scroll}px`;
            player.style.bottom = `${42 + playerY}px`;
            obstacles.forEach((obstacle) => {
                obstacle.node.style.left = `${obstacle.x - scroll}px`;
            });
            alertBar.style.width = `${alertGauge}%`;
            lostBar.style.width = `${lostGauge}%`;
            distanceLabel.textContent = `${Math.max(0, Math.round(distance))}px`;
            const rangeProgress = clamp((distance - config.tooClose) / (config.tooFar - config.tooClose), 0, 1);
            rangeMarker.style.left = `${rangeProgress * 100}%`;
            rangeState.textContent = close ? '危険: 近すぎ' : far ? '危険: 遠すぎ' : ideal ? '適正距離' : '注意';
            if (alertGauge >= 100) {
                finishMini('tailing', false, `容疑者に警戒された…。予定とは違う証言を入手したが、尾行は中断された。`, '警戒100%');
                return;
            }
            if (lostGauge >= 100) {
                finishMini('tailing', false, `${config.suspect}を見失った…。予定とは違う証言を入手したが、追跡は途切れた。`, '見失い100%');
                return;
            }
            frameId = window.requestAnimationFrame(loop);
        };
        cleanupMini = () => {
            window.cancelAnimationFrame(frameId);
            document.removeEventListener('keydown', keydown);
            document.removeEventListener('keyup', keyup);
        };
        frameId = window.requestAnimationFrame(loop);
        startTimer(config.timeLimit, () => finishMini('tailing', true, `尾行成功！${config.suspect}の足取りを押さえ、新たな証拠を入手した。`, '20秒尾行成功'));
    }

    function renderLab(task) {
        const items = task.items || fallbackMiniTask('lab').items;
        const sequence = task.sequence || items.slice(0, 4).map((item) => item.id);
        let input = [];
        const field = miniBody.querySelector('[data-playfield]');
        field.innerHTML = '<p class="deduction-note">点灯パターンを覚える。点灯が終わったら同じ順で押す。</p><div class="lab-grid"></div>';
        const grid = field.querySelector('.lab-grid');
        items.forEach((item) => {
            const button = document.createElement('button');
            button.className = 'lab-button';
            button.type = 'button';
            button.dataset.id = item.id;
            button.textContent = item.name;
            button.disabled = true;
            button.addEventListener('click', () => {
                input.push(item.id);
                button.classList.add('active');
                window.setTimeout(() => button.classList.remove('active'), 160);
                const index = input.length - 1;
                if (input[index] !== sequence[index]) {
                    finishMini('lab', false, '分析順を誤ったが、反応の違いは記録できた。', 'Bad Seq');
                    return;
                }
                if (input.length === sequence.length) {
                    finishMini('lab', true, '分析順を完全再現し、検体の特徴を抽出した。', 'Clean');
                }
            });
            grid.appendChild(button);
        });
        let delay = 300;
        sequence.forEach((id) => {
            window.setTimeout(() => {
                const button = grid.querySelector(`[data-id="${id}"]`);
                button?.classList.add('flash');
                window.setTimeout(() => button?.classList.remove('flash'), 500);
            }, delay);
            delay += 700;
        });
        window.setTimeout(() => {
            grid.querySelectorAll('button').forEach((button) => { button.disabled = false; });
            startTimer(task.timeLimit || 22, () => finishMini('lab', false, '入力前に分析時間が切れた。', 'Timeout'));
        }, delay + 180);
    }

    function renderLock(task) {
        const symbols = task.symbols || ['A', 'B', 'C', 'D', 'E', 'F'];
        const password = task.password || ['C', 'A', 'E', 'B'];
        let guess = [];
        let tries = 0;
        const field = miniBody.querySelector('[data-playfield]');
        field.innerHTML = `<p class="deduction-note">${escapeHtml(task.target || '端末')}を解除。位置一致と含有数を頼りに絞る。</p><div class="lock-guess"></div><div class="symbol-grid"></div><div class="compact-list" data-log></div>`;
        const guessEl = field.querySelector('.lock-guess');
        const log = field.querySelector('[data-log]');
        const paintGuess = () => { guessEl.textContent = guess.join(' ') || '入力待ち'; };
        symbols.forEach((symbol) => {
            const button = document.createElement('button');
            button.className = 'symbol-button';
            button.type = 'button';
            button.textContent = symbol;
            button.addEventListener('click', () => {
                if (guess.length >= password.length) return;
                guess.push(symbol);
                paintGuess();
                if (guess.length === password.length) {
                    tries += 1;
                    const exact = guess.filter((value, index) => value === password[index]).length;
                    const included = guess.filter((value) => password.includes(value)).length;
                    const row = document.createElement('article');
                    row.className = 'board-item';
                    row.innerHTML = `<strong>${escapeHtml(guess.join(' '))}</strong><p>位置一致 ${exact} / 含有 ${included}</p>`;
                    log.prepend(row);
                    if (exact === password.length) {
                        finishMini('lock', true, `ロック解除。${tries}回で侵入ログを確保した。`, `${tries} Try`);
                    }
                    guess = [];
                    paintGuess();
                }
            });
            field.querySelector('.symbol-grid').appendChild(button);
        });
        paintGuess();
        startTimer(task.timeLimit || 48, () => finishMini('lock', false, '解除に時間がかかり、ログの一部だけを取得した。', 'Timeout'));
    }

    async function openFinal() {
        setLoading(true, '最終推理生成中', '全証拠、証言、ターン履歴、ミニゲーム結果を照合しています。');
        try {
            const payload = await api('final', { state: publicState() });
            finalData = payload.final;
            const answer = finalData.answer || {};
            fillSelect('finalCulprit', ensureOptions(finalData.culprits, answer.culprit));
            fillSelect('finalMotive', ensureOptions(finalData.motives, answer.motive));
            fillSelect('finalTrick', ensureOptions(finalData.tricks, answer.trick));
            fillSelect('finalEvidence', ensureOptions(finalData.evidence, answer.evidence));
            finalResult.textContent = '4つの札をそろえて事件を閉じる。';
            finalModal.classList.remove('hidden');
        } catch (error) {
            state.history.push({ title: '最終推理生成失敗', text: formatError(error) });
            render();
        } finally {
            setLoading(false);
        }
    }

    function submitFinal() {
        if (!finalData) return;
        const answer = finalData.answer || {};
        const picked = {
            culprit: valueOf('finalCulprit'),
            motive: valueOf('finalMotive'),
            trick: valueOf('finalTrick'),
            evidence: valueOf('finalEvidence'),
        };
        const success = picked.culprit === answer.culprit && picked.motive === answer.motive && picked.trick === answer.trick && picked.evidence === answer.evidence;
        if (!success) {
            finalResult.textContent = 'まだ噛み合っていない。人物、動機、証拠のどれかがズレている。';
            return;
        }
        if (state.case) state.case.status = '解決';
        state.solved = true;
        state.active = false;
        recordAchievementProgress('caseClears');
        recordSolvedCaseArchive();
        finalModal.classList.add('hidden');
        render();
        showResult();
    }

    function showResult() {
        const truth = state.truth || {};
        document.getElementById('resultTitle').textContent = `${state.case?.title || '事件'} 解決`;
        document.getElementById('resultTruth').textContent = finalData?.explanation || `${truth.culprit}は${truth.motive}。${truth.trick}。決定的証拠は${truth.decisiveEvidence}だった。`;
        const list = document.getElementById('resultMiniList');
        list.innerHTML = '';
        if (!state.miniResults.length) {
            list.innerHTML = '<article class="board-item"><strong>ミニゲームなし</strong><p>聞き込み中心で解決しました。</p></article>';
        }
        state.miniResults.forEach((item, index) => {
            const row = document.createElement('article');
            row.className = 'board-item';
            row.innerHTML = `<strong>${index + 1}. ${escapeHtml(labelMini(item.type))} / ${item.success ? '成功' : '失敗'}</strong><span>${escapeHtml(item.grade || '')}</span><p>${escapeHtml(item.summary)}</p>`;
            list.appendChild(row);
        });
        resultModal.classList.remove('hidden');
        updateOfficeSummary();
    }

    function startCoach() {
        if (state.onboardingSeen) return;
        coachIndex = 0;
        coachBubble.classList.remove('hidden');
        paintCoach();
    }

    function paintCoach() {
        const steps = [
            ['事件画面', '中央の大きなカードが今の展開です。', '.scene-feed', 'coach-right'],
            ['行動選択', '聞き込みか、2つのミニゲームから選びます。候補は次ターンで必ず入れ替わります。', '.action-console', 'coach-left'],
            ['事件ボード', '証拠、証言、ミニゲーム結果は右側のボードで確認します。', '.game-board', 'coach-left'],
            ['最終推理', 'Turn 4から解放。犯人、動機、トリック、決定的証拠をそろえます。', '.action-grid .action-card:last-child', 'coach-bottom'],
        ];
        const step = steps[coachIndex];
        document.querySelectorAll('.coach-highlight').forEach((item) => item.classList.remove('coach-highlight'));
        if (!step) {
            coachBubble.classList.add('hidden');
            state.onboardingSeen = true;
            return;
        }
        document.getElementById('coachTitle').textContent = step[0];
        document.getElementById('coachText').textContent = step[1];
        coachBubble.className = `coach-bubble ${step[3]}`;
        document.querySelector(step[2])?.classList.add('coach-highlight');
    }

    function nextCoachStep() {
        document.querySelectorAll('.coach-highlight').forEach((item) => item.classList.remove('coach-highlight'));
        coachIndex += 1;
        paintCoach();
    }

    async function api(action, body = {}) {
        const response = await fetch('/api/detective', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...body }),
        });
        if (!response.ok) {
            const text = await response.text();
            try {
                const error = JSON.parse(text);
                throw new Error(error.error || text);
            } catch {
                throw new Error(text || response.statusText);
            }
        }
        return response.json();
    }

    function publicState() {
        return {
            turn: state.turn,
            caseTitle: state.case?.title,
            summary: state.case?.summary,
            truth: state.truth,
            people: state.people,
            evidence: state.evidence,
            testimonies: state.testimonies,
            history: state.history,
            miniResults: state.miniResults,
            currentDeduction: state.currentDeduction,
        };
    }

    function addUnique(target, items, key) {
        if (!Array.isArray(items)) return;
        items.forEach((item) => {
            if (!item || target.some((current) => current[key] === item[key])) return;
            target.push(item);
        });
    }

    function loadCaseArchive() {
        try {
            const parsed = JSON.parse(localStorage.getItem(caseArchiveStorageKey) || '[]');
            return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.id && entry.title) : [];
        } catch {
            return [];
        }
    }

    function saveCaseArchive(entries) {
        try {
            localStorage.setItem(caseArchiveStorageKey, JSON.stringify(entries.slice(0, 50)));
        } catch {
            // 保存できない環境でもゲーム進行は止めない。
        }
        window.dispatchEvent(new CustomEvent('detective:archive-change', { detail: entries }));
    }

    function recordSolvedCaseArchive() {
        if (state.archiveRecorded || !state.case || !state.solved) return;
        const truth = state.truth || {};
        const explanation = finalData?.explanation || `${truth.culprit || '真相'}は${truth.motive || '動機不明'}。${truth.trick || ''} 決定的証拠は${truth.decisiveEvidence || '不明'}だった。`;
        const entry = {
            id: `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: state.case.title || '無題の事件',
            location: state.case.location || '現場未記録',
            summary: state.case.summary || '',
            solvedAt: new Date().toISOString(),
            turn: state.turn,
            explanation,
            truth: {
                culprit: truth.culprit || '',
                motive: truth.motive || '',
                trick: truth.trick || '',
                decisiveEvidence: truth.decisiveEvidence || '',
            },
            evidence: state.evidence.map((item) => ({
                name: item.name || item.id || '証拠',
                type: item.type || '証拠',
                detail: item.detail || '',
            })),
            testimonies: state.testimonies.map((item) => ({
                speaker: item.speaker || '証言者',
                claim: item.claim || item.detail || '',
            })),
            miniResults: state.miniResults.map((item) => ({
                type: item.type,
                label: labelMini(item.type),
                success: Boolean(item.success),
                grade: item.grade || '',
                summary: item.summary || '',
                turn: item.turn || 0,
            })),
        };
        saveCaseArchive([entry, ...loadCaseArchive()]);
        state.archiveRecorded = true;
    }

    function loadAchievements() {
        const fallback = { unlocked: [], caseClears: 0, miniSuccesses: 0, miniFailures: 0 };
        try {
            const parsed = JSON.parse(localStorage.getItem(achievementStorageKey) || '{}');
            return {
                unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked.filter((id) => typeof id === 'string') : [],
                caseClears: Number(parsed.caseClears) || 0,
                miniSuccesses: Number(parsed.miniSuccesses) || 0,
                miniFailures: Number(parsed.miniFailures) || 0,
            };
        } catch {
            return fallback;
        }
    }

    function saveAchievements() {
        try {
            localStorage.setItem(achievementStorageKey, JSON.stringify(achievementState));
        } catch {
            // 保存できない環境でも、そのセッション中は実績を扱えるようにする。
        }
        window.dispatchEvent(new CustomEvent('detective:achievement-change', { detail: getAchievementSnapshot() }));
    }

    function recordAchievementProgress(stat) {
        achievementState[stat] = (Number(achievementState[stat]) || 0) + 1;
        const unlockedNow = [];
        achievementDefinitions.forEach((achievement) => {
            if (achievement.stat !== stat) return;
            if (achievementState.unlocked.includes(achievement.id)) return;
            if ((Number(achievementState[achievement.stat]) || 0) < achievement.threshold) return;
            achievementState.unlocked.push(achievement.id);
            unlockedNow.push(achievement);
        });
        saveAchievements();
        unlockedNow.forEach(showAchievementToast);
    }

    function getAchievementSnapshot() {
        const unlocked = new Set(achievementState.unlocked);
        const items = achievementDefinitions.map((achievement) => ({
            ...achievement,
            unlocked: unlocked.has(achievement.id),
            progress: Math.min(Number(achievementState[achievement.stat]) || 0, achievement.threshold),
        }));
        return {
            definitions: achievementDefinitions,
            items,
            state: { ...achievementState, unlocked: [...achievementState.unlocked] },
            unlockedCount: items.filter((item) => item.unlocked).length,
            totalCount: items.length,
        };
    }

    function showAchievementToast(achievement) {
        const stack = ensureAchievementToastStack();
        const toast = document.createElement('article');
        toast.className = 'achievement-toast';
        toast.innerHTML = `
            <span class="achievement-toast-rule">🏆━━━━━━━━━━━━</span>
            <strong>実績解除！</strong>
            <b>【${escapeHtml(achievement.name)}】</b>
            <p>${escapeHtml(achievement.description)}</p>
            <span class="achievement-toast-rule">━━━━━━━━━━━━🏆</span>
        `;
        stack.appendChild(toast);
        window.setTimeout(() => toast.classList.add('fade-out'), 3600);
        window.setTimeout(() => toast.remove(), 4400);
    }

    function ensureAchievementToastStack() {
        let stack = document.getElementById('achievementToastStack');
        if (!stack) {
            stack = document.createElement('section');
            stack.id = 'achievementToastStack';
            stack.className = 'achievement-toast-stack';
            stack.setAttribute('aria-live', 'polite');
            document.body.appendChild(stack);
        }
        return stack;
    }

    function setLoading(isLoading, title = 'AI通信中', text = 'OpenAI APIから応答を待っています。') {
        state.loading = isLoading;
        actionGrid?.querySelectorAll('button').forEach((button) => { button.disabled = isLoading; });
        if (isLoading) {
            loadingTitle.textContent = title;
            loadingText.textContent = text;
            loadingEl.classList.remove('hidden');
        } else {
            loadingEl.classList.add('hidden');
        }
        document.getElementById('gameStatusLabel').textContent = isLoading ? 'ロード中' : (state.case?.status || '捜査中');
    }

    function fillSelect(id, items) {
        const select = document.getElementById(id);
        select.innerHTML = '';
        (items || []).forEach((value) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            select.appendChild(option);
        });
    }

    function ensureOptions(items, answer) {
        return [...new Set([answer, ...(items || [])].filter(Boolean))];
    }

    function valueOf(id) {
        return document.getElementById(id).value;
    }

    function labelMini(type) {
        return {
            timeline: '時系列シャッフル',
            laser: 'レーザースキャン',
            tailing: 'ステルス尾行',
            lab: 'メモリー鑑識',
            lock: 'コードブレイク',
            talk: '聞き込み',
        }[type] || type;
    }

    function miniCatch(type) {
        return {
            timeline: '順番を組み替える',
            laser: '痕跡を撃ち抜く',
            tailing: '距離を保って追う',
            lab: '光を覚えて押す',
            lock: 'ヒントで解除',
        }[type] || '捜査';
    }

    function describeMini(type) {
        return {
            timeline: '出来事カードを正しい順に並べる。',
            laser: '全ターゲットを制限時間内にクリックする。',
            tailing: '障害物を避けながら20秒間距離を保つ。',
            lab: '光った順番を記憶して再入力する。',
            lock: '位置一致と含有数からコードを当てる。',
        }[type] || '捜査ミニゲーム';
    }

    function ruleText(type, task) {
        const seconds = type === 'tailing' ? 20 : (task.timeLimit || ({ timeline: 40, laser: 28, lab: 22, lock: 48 }[type] || 30));
        const data = {
            timeline: ['事件の順番を戻せ', 'カードを上下に動かして、事件の流れを復元する。', 'ほぼ正しい順序で確定', '順序が大きくズレる'],
            laser: ['痕跡を撃ち抜け', '左右移動で照準位置を合わせ、Spaceでレーザーを撃つ。インベーダー風に全ターゲットを撃破する。', '全ターゲットを撃破', '取り逃しが残る'],
            tailing: ['近すぎず遠すぎず', '横スクロールで進み続ける。左右で速度を微調整し、ジャンプで障害物を避けながら容疑者との距離を20秒保つ。', '20秒間距離を維持', '警戒または見失い100%'],
            lab: ['光を記憶しろ', '光った分析ボタンの順番を覚えて、同じ順で押す。', '最後まで正しく入力', '順番ミスか時間切れ'],
            lock: ['コードを破れ', '記号を入力し、位置一致と含有数から正解を探る。', '時間内に解除', '解除できない'],
        }[type] || ['捜査開始', describeMini(type), 'クリア', '失敗'];
        return { title: data[0], body: data[1], success: data[2], failure: data[3], seconds };
    }

    function fallbackMiniTask(type) {
        if (type === 'laser') return { timeLimit: 28, targets: [
            { id: 'l1', name: '指紋', x: 22, y: 30 },
            { id: 'l2', name: '繊維', x: 70, y: 42 },
            { id: 'l3', name: '血痕', x: 48, y: 72 },
        ] };
        if (type === 'lab') return { timeLimit: 22, items: [
            { id: 'a', name: 'DNA' }, { id: 'b', name: '試薬' }, { id: 'c', name: '血液' }, { id: 'd', name: '繊維' },
        ], sequence: ['b', 'c', 'a', 'd'] };
        if (type === 'lock') return { timeLimit: 48, target: '端末', symbols: ['A', 'B', 'C', 'D', 'E', 'F'], password: ['C', 'A', 'E', 'B'] };
        if (type === 'tailing') return { timeLimit: 20, suspect: '容疑者', place: '夜道', idealMin: 200, idealMax: 350, tooClose: 150, tooFar: 500, situation: '容疑者が人気の少ない道へ向かっている。' };
        return { timeLimit: 40, cards: [
            { id: 't1', text: '署名を確認', order: 1 },
            { id: 't2', text: '加湿器が作動', order: 2 },
            { id: 't3', text: '署名欄がにじむ', order: 3 },
            { id: 't4', text: '異変を発見', order: 4 },
        ] };
    }

    function tailingPlaceClass(place) {
        const text = String(place || '').toLowerCase();
        if (/商店|market|街/.test(text)) return 'place-market';
        if (/港|port|湾/.test(text)) return 'place-port';
        if (/公園|park/.test(text)) return 'place-park';
        if (/地下|subway|underground/.test(text)) return 'place-underground';
        if (/オフィス|office|ビル/.test(text)) return 'place-office';
        return 'place-night';
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function formatError(error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/OPENAI_API_KEY|API_KEY/i.test(message)) return 'APIキー未設定。フォールバックで続行します。';
        return message.slice(0, 220);
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    }
})();
