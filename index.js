const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// --- API Client Init ---
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Global States ---
let gambleActive = false;
let localLastResetDate = null;
const spamRecords = {};
const gameState = {}; // 全ゲームの進行状況管理

// 起動時にギャンブル状態を取得
supabase.from('config').select('value').eq('key', 'gamble_active').single().then(r => {
    if (r.data) gambleActive = r.data.value === 'true';
}).catch(()=>{});

// --- Date Utils ---
const getTodayStr = () => new Date(Date.now() + 32400000).toISOString().split('T')[0];
const getThisMonthStr = () => new Date(Date.now() + 32400000).toISOString().slice(0, 7);
const fNum = (n) => Number(n).toLocaleString();

const verifySignature = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    if (!sig || !req.rawBody) return false;
    const expected = crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
    return sig === expected;
};

// --- Chatwork Messages ---
const makeRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

const sendTempMessage = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};
const sendMessage = (rid, txt) => cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`).catch(()=>{});

// --- お金・借金管理 (自動返済機能) ---
const addMoney = async (aid, amount) => {
    const { data: p } = await supabase.from('players').select('*').eq('account_id', aid).single();
    let money = p ? p.money : 0;
    let debt = p ? (p.debt || 0) : 0;

    // 稼いだ額から優先して借金を返済する
    if (debt > 0 && amount > 0) {
        let repay = Math.min(debt, amount);
        debt -= repay; amount -= repay;
    }
    money += amount;

    if (p) {
        await supabase.from('players').update({ money, debt }).eq('account_id', aid);
    } else {
        await supabase.from('players').insert({ account_id: aid, money, debt, slot_count: 0, work_limit: 5, msg_count: 0, job: 'サラリーマン' });
    }
};

// --- 管理・防衛機能 ---
const isUserAdmin = async (rid, aid) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const kickTarget = async (rid, targetAids, action = 'readonly') => {
    try {
        const { data: membersList } = await cw.get(`/rooms/${rid}/members`);
        let admins = membersList.filter(m => m.role === 'admin' || m.role === 'creator').map(m => m.account_id.toString());
        let members = membersList.filter(m => m.role === 'member').map(m => m.account_id.toString());
        let readonlys = membersList.filter(m => m.role === 'readonly').map(m => m.account_id.toString());
        let found = false;

        for (const aid of targetAids) {
            let id = aid.toString();
            if (admins.includes(id) || members.includes(id) || readonlys.includes(id)) found = true;
            admins = admins.filter(x => x !== id);
            members = members.filter(x => x !== id);
            readonlys = readonlys.filter(x => x !== id);
            if (action === 'readonly') readonlys.push(id);
        }
        if (!found) return;

        const params = new URLSearchParams();
        if (admins.length > 0) params.append('members_admin_ids', admins.join(','));
        if (members.length > 0) params.append('members_member_ids', members.join(','));
        if (readonlys.length > 0) params.append('members_readonly_ids', readonlys.join(','));
        await cw.put(`/rooms/${rid}/members`, params.toString());
    } catch(e) {}
};

const checkSpam = (aid) => {
    const now = Date.now();
    if (!spamRecords[aid]) spamRecords[aid] = [];
    spamRecords[aid].push(now);
    spamRecords[aid] = spamRecords[aid].filter(t => now - t <= 5000);
    return (spamRecords[aid].length >= 10);
};

// --- ゲームエンジン ---
const generateDerby = () => {
    let stats = []; for(let i=0; i<6; i++) stats.push(Math.random() * 10 + 1);
    let combos = [], totalWeight = 0;
    let oddsMap = {}, oddsStr = "";
    
    for(let i=1; i<=5; i++){
        for(let j=i+1; j<=6; j++){
            let w = stats[i-1] * stats[j-1];
            combos.push({ c: `${i}-${j}`, w });
            totalWeight += w;
        }
    }
    
    combos.forEach(c => {
        let odd = (0.8 / (c.w / totalWeight)).toFixed(1);
        if (odd < 1.1) odd = 1.1; if (odd > 150) odd = 150.0;
        oddsMap[c.c] = Number(odd);
    });
    
    Object.keys(oddsMap).sort((a,b) => oddsMap[a] - oddsMap[b]).forEach(k => {
        oddsStr += `🐎 ${k} : [code]${oddsMap[k]}倍[/code]\n`;
    });
    return { oddsMap, oddsStr, stats };
};

const getChinchiroRoll = () => {
    for (let i = 0; i < 3; i++) {
        let d = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if (d[0]===1 && d[1]===1 && d[2]===1) return { d, n: "ピンゾロ", r: 6, s: 1, m: 5 };
        if (d[0]===d[1] && d[1]===d[2]) return { d, n: `${d[0]}の嵐`, r: 5, s: d[0], m: 3 };
        if (d[0]===4 && d[1]===5 && d[2]===6) return { d, n: "シゴロ", r: 4, s: 6, m: 2 };
        if (d[0]===1 && d[1]===2 && d[2]===3) return { d, n: "ヒフミ", r: 0, s: 0, m: -2 };
        if (d[0]===d[1]) return { d, n: `${d[2]}の目`, r: 2, s: d[2], m: 1 };
        if (d[1]===d[2]) return { d, n: `${d[0]}の目`, r: 2, s: d[0], m: 1 };
        if (d[0]===d[2]) return { d, n: `${d[1]}の目`, r: 2, s: d[1], m: 1 };
    }
    return { d: [0,0,0], n: "目なし", r: 1, s: 0, m: 1 };
};

// --- ゲーム進行・タイマー ---
const startGameTimer = (rid, ms = 60000, isDerby = false) => {
    let game = gameState[rid]; if (!game) return;
    
    if (game.timeoutId) clearTimeout(game.timeoutId);
    if (game.remindId) clearTimeout(game.remindId);
    
    if (isDerby) {
        game.remindId = setTimeout(() => {
            if (gameState[rid] && gameState[rid].state === 'BETTING') {
                sendTempMessage(rid, `[info]⏳ 競馬のベット締め切りまで【残り1分】です！\nまだの方は [code]/bet [額] [馬番-馬番][/code] を入力してください。[/info]`);
            }
        }, ms - 60000);
    }
    game.timeoutId = setTimeout(() => handleGameTimeout(rid), ms);
};

const handleGameTimeout = async (rid) => {
    let game = gameState[rid]; if (!game || game.state === 'IDLE') return;

    if (game.state === 'RECRUITING') {
        if (game.players.length >= 2) {
            game.state = 'BETTING';
            if (game.type === 'derby') {
                let ex = `\n【 🐎 馬連オッズ 】\n${game.oddsStr}\n[hr]👉 [code]/bet [額] [馬1]-[馬2][/code] (例: /bet 100 1-2)`;
                await sendTempMessage(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n[hr](※制限2分。残り1分でリマインドします)[/info]`, 120000);
                startGameTimer(rid, 120000, true);
            } else {
                let ex = `👉 [code]/bet [額][/code] でベットしてください。`;
                await sendTempMessage(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /bet max や /bet half も使えます)[/info]`);
                startGameTimer(rid, 60000);
            }
        } else {
            await sendTempMessage(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満のため、ゲームを中止します。[/info]`);
            gameState[rid] = null;
        }
    } else {
        let kicked = [], activePlayers = [];
        for (let p of game.players) {
            let isKicked = false;
            if (game.state === 'BETTING' && p.bet === 0) isKicked = true;
            if (game.state === 'ACTION' && (game.type === 'chouhan' && !p.choice || game.type === 'chinchiro' && !p.res && p.aid !== game.host)) isKicked = true;
            
            if (isKicked) { 
                kicked.push(p.aid); 
                if (p.bet > 0) await addMoney(p.aid, p.bet); 
            } else {
                activePlayers.push(p);
            }
        }
        game.players = activePlayers;
        
        if (kicked.length > 0) {
            await sendTempMessage(rid, `[info][title]⏳ タイムアウト[/title]時間切れのため、以下のプレイヤーを退出・返金しました。\n${kicked.map(a => `[piconname:${a}]`).join(' ')}[/info]`);
        }
        
        if (game.players.length < 2) {
            for (let p of game.players) if (p.bet > 0) await addMoney(p.aid, p.bet);
            await sendTempMessage(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満になったため中止し、全額返金しました。[/info]`);
            gameState[rid] = null;
        } else {
            await checkGameProgress(rid);
        }
    }
};

const checkGameProgress = async (rid) => {
    let game = gameState[rid]; if (!game || game.state === 'IDLE') return;
    
    if (game.state === 'BETTING' && game.players.length >= 2 && game.players.every(p => p.bet > 0)) {
        if (game.type === 'derby') {
            clearTimeout(game.timeoutId); if (game.remindId) clearTimeout(game.remindId);
            await resolveDerby(rid);
        } else {
            game.state = 'ACTION';
            let txt = game.type === 'chouhan' ? "丁半を予想し、 [code]/chou[/code] (丁) または [code]/han[/code] (半) と発言してください。" : "親以外は [code]/roll[/code] でサイコロを振ってください。";
            await sendTempMessage(rid, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n[hr](※制限時間: 1分)[/info]`);
            startGameTimer(rid, 60000);
        }
    } else if (game.state === 'ACTION') {
        if (game.type === 'chouhan' && game.players.length >= 2 && game.players.every(p => p.choice)) await resolveChouhan(rid);
        if (game.type === 'chinchiro' && game.players.length >= 2 && game.players.filter(x => x.aid !== game.host).every(p => p.res)) await resolveChinchiro(rid);
    }
};

// --- ゲーム結果精算 ---
const resolveChinchiro = async (rid) => {
    let game = gameState[rid]; if (!game) return; clearTimeout(game.timeoutId);
    let parentRoll = getChinchiroRoll(); 
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title]【 親 ([piconname:${game.host}]) の出目 】\n[ ${parentRoll.d.join(', ')} ] ➡ 『 ${parentRoll.n} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let p of game.players) {
        if (p.aid === game.host) continue;
        let r = p.res || { r: 1, n: "欠席", m: 1, s: 0, d: [0,0,0] };
        let win = (r.r > parentRoll.r) || (r.r === parentRoll.r && r.s > parentRoll.s);
        let draw = (r.r === parentRoll.r && r.s === parentRoll.s);
        
        if (draw) { 
            await addMoney(p.aid, p.bet); 
            msg += `😐 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 引き分け (返金)\n`; 
        } else if (win) { 
            let mult = r.m > 0 ? r.m : 1; await addMoney(p.aid, p.bet + (p.bet * mult)); 
            msg += `(cracker) [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 勝ち！ (+${fNum(p.bet * mult)})\n`; 
        } else { 
            msg += `💀 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 負け...\n`; 
        }
    }
    sendMessage(rid, msg + "[/info]"); 
    gameState[rid] = null; await supabase.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resolveChouhan = async (rid) => {
    let game = gameState[rid]; if (!game) return; clearTimeout(game.timeoutId);
    let d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1, sum = d1 + d2, result = (sum % 2 === 0) ? 'chou' : 'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${result === 'chou' ? '丁(偶数)' : '半(奇数)'} 』\n[hr]【 プレイヤー結果 】\n`;
    
    for (let p of game.players) {
        if (p.choice === result) { await addMoney(p.aid, p.bet * 2); msg += `(cracker) [piconname:${p.aid}]: 的中！ (+${fNum(p.bet * 2)} コイン)\n`; } 
        else { msg += `💀 [piconname:${p.aid}]: 予想[${p.choice === 'chou' ? '丁' : '半'}] ➡ はずれ...\n`; }
    }
    sendMessage(rid, msg + "[/info]"); 
    gameState[rid] = null; await supabase.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resolveDerby = async (rid) => {
    let game = gameState[rid]; if (!game) return; clearTimeout(game.timeoutId); if (game.remindId) clearTimeout(game.remindId);
    let stats = game.st, ws = [...stats], totalW = ws.reduce((a, b) => a + b, 0);
    
    let r1 = Math.random() * totalW, s1 = 0, first = 1;
    for(let i=0; i<6; i++){ s1 += ws[i]; if(r1 <= s1){ first = i+1; break; } }
    
    ws[first-1] = 0; totalW = ws.reduce((a, b) => a + b, 0);
    let r2 = Math.random() * totalW, s2 = 0, second = 1;
    for(let i=0; i<6; i++){ s2 += ws[i]; if(r2 <= s2){ second = i+1; break; } }
    
    let winCombo = first < second ? `${first}-${second}` : `${second}-${first}`, odd = game.oddsMap[winCombo];
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${first} 】番と【 ${second} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winCombo} 】 (${odd}倍)\n[hr]【 プレイヤー結果 】\n`;
    
    for(let p of game.players){
        if(p.choice === winCombo){ let winAmt = Math.floor(p.bet * odd); await addMoney(p.aid, p.bet + winAmt); msg += `(cracker) [piconname:${p.aid}]: 的中！ (+${fNum(winAmt)} コイン)\n`; } 
        else { msg += `💀 [piconname:${p.aid}]: 予想[${p.choice}] ➡ はずれ...\n`; }
    }
    sendMessage(rid, msg + "[/info]"); 
    gameState[rid] = null; await supabase.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};
// --- 前半ここまで ---
// --- 後半ここから ---
app.post('/webhook', (req, res) => {
    if (!verifySignature(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const roomId = ev.room_id, body = ev.body || "", senderId = ev.account_id.toString(), msgId = ev.message_id;
    const today = getTodayStr(), thisMonth = getThisMonthStr();

    (async () => {
        try {
            // --- 返信タグの解析 ---
            const rpMatch = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const repliedAid = rpMatch ? rpMatch[1] : null;

            // 1. プレイヤーデータの確実な取得と作成（ここが修正の核です）
            let { data: pData } = await supabase.from('players').select('*').eq('account_id', senderId).single();
            
            // 未登録なら無条件で作成する
            if (!pData) {
                pData = { account_id: senderId, money: 0, debt: 0, slot_count: 0, work_limit: 5, msg_count: 0, job: 'サラリーマン' };
                await supabase.from('players').insert(pData);
            } 
            // 登録済みで、普通のチャット（コマンド以外）なら仕事回数を回復
            else if (gambleActive && !body.startsWith('/')) {
                let mc = (pData.msg_count || 0) + 1; 
                let wl = pData.work_limit || 5;
                if (mc >= (Math.floor(Math.random() * 21) + 30)) { mc = 0; if (wl < 10) wl++; }
                pData.msg_count = mc; pData.work_limit = wl;
                await supabase.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', senderId);
            }

            let myMoney = pData.money;
            let myDebt = pData.debt || 0;
            let myJob = pData.job || 'サラリーマン';
            let currentMonthlyDebt = (pData.debt_month === thisMonth) ? (pData.monthly_debt || 0) : 0;

            // 2. ブラックリスト防衛
            const { data: isBanned } = await supabase.from('blacklist').select('account_id').eq('account_id', senderId).single();
            if (isBanned) { 
                await kickTarget(roomId, [senderId], 'readonly'); 
                await cw.delete(`/rooms/${roomId}/messages/${msgId}`).catch(()=>{}); 
                return; 
            }

            // 3. スパム（連投）防衛
            if (checkSpam(senderId) && !(await isUserAdmin(roomId, senderId))) {
                await kickTarget(roomId, [senderId], 'readonly');
                return sendTempMessage(roomId, `[info][title]⚠️ 警告[/title][piconname:${senderId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 4. 深夜0時リセット & 宝くじ抽選
            if (localLastResetDate !== today) {
                const { data: configDate } = await supabase.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!configDate || configDate.value !== today) {
                    await supabase.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await supabase.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastResetDate = today;
                    
                    let resetMsg = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\nスロット回数、おみくじ、お仕事制限がリセットされました！\n[hr]`;
                    
                    const { data: tData } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tickets = tData ? JSON.parse(tData.value) : [];
                    if (tickets.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        resetMsg += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 ${win} 】です！\n[hr]`;
                        let payouts = {}; let winners = [];
                        
                        const checkPrize = (n, w) => {
                            if (n === w) return { p: 30000, name: '🥇 1等' };
                            let prev = w - 1 < 1 ? 9999 : w - 1, next = w + 1 > 9999 ? 1 : w + 1;
                            if (n === prev || n === next) return { p: 15000, name: '🥈 前後賞' };
                            if (n % 1000 === w % 1000) return { p: 10000, name: '🥈 2等' }; 
                            if (n % 100 === w % 100) return { p: 5000, name: '🥉 3等' };    
                            if (n % 10 === w % 10) return { p: 1000, name: '🏅 4等' };      
                            return null;
                        };
                        
                        for (let t of tickets) { 
                            let r = checkPrize(t.num, win); 
                            if(r) { winners.push({ a: t.aid, num: t.num, ...r }); payouts[t.aid] = (payouts[t.aid] || 0) + r.p; } 
                        }
                        
                        if (winners.length > 0) {
                            for (let aid in payouts) await addMoney(aid, payouts[aid]);
                            winners.sort((a,b) => b.p - a.p); 
                            for (let w of winners.slice(0, 20)) resetMsg += `(cracker) [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.name} (+${fNum(w.p)} コイン)\n`;
                            if (winners.length > 20) resetMsg += `...他 ${winners.length - 20} 件の当選！\n`;
                        } else {
                            resetMsg += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`;
                        }
                        await supabase.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMessage(roomId, resetMsg + `[/info]`);
                }
            }

            // --- 📖 ヘルプコマンド ---
            if (body.trim() === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内 (V39 FINAL)[/title]
【 🏦 銀行・ステータス 】
・ [code]/status[/code] : 状態確認
・ [code]/give [金額][/code] : 相手に送金 (税金10%)
・ [code]/debt [金額][/code] : 借金 (月上限5000)
・ [code]/money-rank[/code] : 純資産ランキング

【 💼 職業・スキル 】
・ [code]/job[/code] : 転職と求人
・ [code]/work[/code] : 職業給料 (10分に1回, 1日5回上限)
・ [code]/catch[/code] または [code]/goal[/code] : 職業専用能力
・ [code]/omikuji[/code] : 1日1回おみくじ (スロット確率変動)

【 🎰 カジノ・宝くじ 】
・ [code]/slot [掛金|max|half][/code] : スロット (1日3回)
・ [code]/buy-lot [連番|バラ] [枚数][/code] : 宝くじ

【 🎲 テーブルゲーム (3分間隔) 】
・ [code]/chouhan[/code] : 丁半ゲーム募集
・ [code]/cc[/code] : チンチロリン募集 ([code]/roll[/code] でサイコロ)
・ [code]/derby[/code] : ダービー募集 ([code]/bet [額] [馬連][/code])

【 👑 管理者専用 】
・ [code]/take [金][/code] : 特別資金付与
・ [code]/st-gya[/code], [code]/fi-gya[/code] : 有効/無効化
・ [code]/blacklist[/code], [code]/remove-rank[/code] 等[/info]`;
                return sendTempMessage(roomId, h, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && gambleActive && await isUserAdmin(roomId, senderId)) {
                let amt = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let targetAid = repliedAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (targetAid && amt > 0) { 
                    await addMoney(targetAid, amt); 
                    return sendTempMessage(roomId, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${targetAid}] 様へ ${fNum(amt)} コインを付与しました。[/info]`); 
                }
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isUserAdmin(roomId, senderId)) {
                let targetAid = repliedAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!targetAid && cmd !== 'add') return; 
                if (!targetAid && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(targetAid)) { 
                        ex = ex.filter(i => i !== targetAid); 
                        sendTempMessage(roomId, `[info][title]設定完了[/title][piconname:${targetAid}] 様のランキング除外を解除しました。[/info]`); 
                    } else { 
                        ex.push(targetAid); 
                        sendTempMessage(roomId, `[info][title]設定完了[/title][piconname:${targetAid}] 様をランキングから除外しました。[/info]`); 
                    }
                    return await supabase.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                
                if (cmd === 'add') { 
                    await supabase.from('blacklist').insert({account_id: targetAid}); 
                    await kickTarget(roomId, [targetAid], 'readonly'); 
                    return sendTempMessage(roomId, `[info][title]🚫 追放完了[/title][piconname:${targetAid}] をブラックリストに登録し、権限を「閲覧のみ」に変更しました。[/info]`); 
                } else if (cmd === 'remove') { 
                    await supabase.from('blacklist').delete().eq('account_id', targetAid); 
                    return sendTempMessage(roomId, `[info][title]✅ 解除完了[/title][piconname:${targetAid}] の追放状態を解除しました。[/info]`); 
                } else if (cmd === 'list') { 
                    const { data: ls } = await supabase.from('blacklist').select('account_id'); 
                    const listStr = ls && ls.length ? ls.map(d => `[piconname:${d.account_id}]`).join('\n') : "登録なし";
                    return sendTempMessage(roomId, `[info][title]📜 ブラックリスト一覧[/title]${listStr}\n[hr]※1分後に自動消滅します[/info]`); 
                }
            }

            if (body.startsWith('/st-gya') && await isUserAdmin(roomId, senderId)) { 
                gambleActive = true; await supabase.from('config').upsert({key:'gamble_active', value:'true'}); 
                return sendMessage(roomId, `[info][title]🎰 カジノ＆ライフ[/title]システムが【 有効 】になりました！[/info]`); 
            }
            if (body.startsWith('/fi-gya') && await isUserAdmin(roomId, senderId)) { 
                gambleActive = false; await supabase.from('config').upsert({key:'gamble_active', value:'false'}); 
                return sendMessage(roomId, `[info][title]🚫 カジノ＆ライフ[/title]システムが【 停止 】しました。[/info]`); 
            }

            // --- ⛩️ おみくじ ---
            if (/(^|\n)\/omikuji\b/.test(body) && gambleActive) {
                if (pData.omikuji_date === today) return sendTempMessage(roomId, `[info][title]⚠️ おみくじ[/title]${makeRp(senderId, roomId, msgId)}\n本日のおみくじは既に引いています。\n(結果: ${pData.omikuji_result})[/info]`);
                
                let r = Math.random() * 100, res = "", eff = "";
                if(r < 10) { res = "大吉"; eff = "(cracker) スロット確率が【大幅UP】！"; } 
                else if(r < 30) { res = "中吉"; eff = "(cracker) スロット確率が【少しUP】！"; } 
                else if(r < 60) { res = "小吉"; eff = "🎯 スロット確率は通常通りです。"; } 
                else if(r < 85) { res = "吉"; eff = "🎯 スロット確率は通常通りです。"; } 
                else if(r < 95) { res = "凶"; eff = "💧 スロット確率が【少しDOWN】..."; } 
                else { res = "大凶"; eff = "💀 スロット確率が【大幅DOWN】..."; }
                
                await supabase.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', senderId);
                return sendMessage(roomId, `[info][title]⛩️ おみくじ結果[/title]${makeRp(senderId, roomId, msgId)}\n[hr]今日の運勢は...【 ${res} 】です！\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行関連 (借金・送金) ---
            const debtMatch = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (debtMatch && gambleActive) {
                let amt = parseInt(debtMatch[2], 10);
                if (amt > 0) {
                    if (currentMonthlyDebt + amt > 5000) return sendTempMessage(roomId, `[info][title]⚠️ 借金上限エラー[/title]${makeRp(senderId, roomId, msgId)}\n1ヶ月の借金上限(5000)を超過します！\n(今月は既に ${currentMonthlyDebt} コイン借りています)[/info]`);
                    
                    await supabase.from('players').update({ money: myMoney + amt, debt: myDebt + amt, monthly_debt: currentMonthlyDebt + amt, debt_month: thisMonth }).eq('account_id', senderId);
                    return sendTempMessage(roomId, `[info][title]💳 お借り入れ完了[/title][piconname:${senderId}] 様\n${fNum(amt)} コインを借金しました。\n[hr]今月の借金可能枠: 残り ${fNum(5000 - (currentMonthlyDebt + amt))} コイン[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && gambleActive) {
                let targetAid = repliedAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let amt = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                
                if (targetAid && amt > 0) {
                    let av = Math.max(0, myMoney - myDebt); 
                    if (av < amt) return sendTempMessage(roomId, `[info][title]⚠️ 送金エラー[/title]${makeRp(senderId, roomId, msgId)}\n送金枠(純資産)が不足しています！\n(借金があるため、送金可能額は ${fNum(av)} コインのみです)[/info]`);
                    
                    let tax = Math.floor(amt * 0.10); let rAmt = amt - tax;
                    await supabase.from('players').update({ money: myMoney - amt }).eq('account_id', senderId);
                    
                    const { data: rc } = await supabase.from('players').select('*').eq('account_id', targetAid).single();
                    if (rc) await supabase.from('players').update({ money: rc.money + rAmt }).eq('account_id', targetAid);
                    else await supabase.from('players').insert({ account_id: targetAid, money: rAmt, debt: 0 });
                    
                    return sendTempMessage(roomId, `[info][title]🎁 送金完了[/title][piconname:${senderId}] ➡ [piconname:${targetAid}]\n${fNum(amt)} コインを送金しました。\n[hr]※システム税 10% (${fNum(tax)} コイン) が引かれ、相手には ${fNum(rAmt)} コインが届きました。[/info]`);
                }
            }

            // --- 📊 ステータス & ランキング ---
            if (body.trim() === '/status') {
                const remSlot = Math.max(0, 3 - pData.slot_count);
                const dStr = myDebt > 0 ? `\n💳 借金: -${fNum(myDebt)} コイン` : '';
                const omi = (pData.omikuji_date === today && pData.omikuji_result) ? `\n⛩️ 今日の運勢: ${pData.omikuji_result}` : "";
                return sendTempMessage(roomId, `[info][title]📊 プレイヤー情報[/title][piconname:${senderId}] 様\n\n💰 所持金: ${fNum(myMoney)} コイン${dStr}\n💎 純資産: ${fNum(myMoney - myDebt)} コイン\n[hr]👔 職業: ${myJob}\n🎰 スロット残り: ${remSlot} 回\n💼 お仕事残り: ${pData.work_limit} 回${omi}\n[hr]※1分後に自動消去されます[/info]`);
            }

            if (body.trim() === '/money-rank') {
                const { data: eD } = await supabase.from('config').select('value').eq('key','rank_excluded').single(); 
                let eI = eD ? JSON.parse(eD.value) : [];
                const { data: ls } = await supabase.from('players').select('*'); 
                let f = ls ? ls.filter(d => !eI.includes(d.account_id)) : [];
                
                f.sort((a,b) => ((b.money||0) - (b.debt||0)) - ((a.money||0) - (a.debt||0)));
                let s = f.slice(0, 10).map((d, i) => {
                    let net = (d.money||0) - (d.debt||0); 
                    let md = i===0 ? "🥇" : (i===1 ? "🥈" : (i===2 ? "🥉" : "🔹")); 
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${fNum(net)} コイン ${d.debt>0 ? `(借金:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                
                return sendTempMessage(roomId, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※5分後に自動消滅します[/info]`, 300000);
            }

            // --- 💼 職業機能 ---
            const cJobMatch = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (cJobMatch && gambleActive) {
                const jn = cJobMatch[2]; const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJob === jn) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\nすでに ${jn} に就いています！[/info]`);
                if (myMoney < cs[jn]) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\nお金が足りません！(転職費用: ${fNum(cs[jn])} コイン)[/info]`);
                
                await supabase.from('players').update({ job: jn, money: myMoney - cs[jn] }).eq('account_id', senderId);
                return sendTempMessage(roomId, `[info][title]🎉 転職完了[/title][piconname:${senderId}] 様\n本日より「${jn}」としてご活躍ください！ (-${fNum(cs[jn])} コイン)[/info]`);
            } else if (body.trim() === '/job' && gambleActive) {
                return sendTempMessage(roomId, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 サラリーマン (費用: 0)
 ▶ [code]/work[/code] (100〜500) ※10%でミス0

🏛️ 公務員 (費用: 2000)
 ▶ [code]/work[/code] (300〜500)

🚓 警察官 (費用: 3000)
 ▶ [code]/work[/code] (300〜700)
 ▶ [code]/catch[/code] (30%の確率で犯人逮捕! 800)

⚽ プロスポーツ選手 (費用: 5000)
 ▶ [code]/work[/code] (500〜1000)
 ▶ [code]/goal[/code] (30%の確率でゴール! 1000)
[hr]※転職コマンド: [code]/job 役職名[/code][/info]`);
            }

            if (/(^|\n)\/work\b/.test(body) && gambleActive) {
                if (pData.work_limit <= 0) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                if (Date.now() - (pData.last_work_time || 0) < 600000) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\n休憩中です！仕事は10分間隔で行えます。[/info]`);
                
                let e = 0, m = "";
                if(myJob === 'サラリーマン'){ if(Math.random() < 0.1){ e=0; m="仕事で重大なミスをしてしまい、本日の給料は 0 コインに...😭"; } else { e=Math.floor(Math.random()*401)+100; m=`真面目に働き、 ${fNum(e)} コイン稼ぎました！💼`; } }
                else if(myJob === '公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、 ${fNum(e)} コイン稼ぎました！🏛️`; }
                else if(myJob === '警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、 ${fNum(e)} コイン稼ぎました！🚓`; }
                else if(myJob === 'プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、 ${fNum(e)} コイン稼ぎました！⚽`; }
                
                await supabase.from('players').update({ last_work_time: Date.now(), work_limit: pData.work_limit - 1 }).eq('account_id', senderId);
                await addMoney(senderId, e); 
                return sendTempMessage(roomId, `[info][title]💼 お仕事完了[/title][piconname:${senderId}]\n${m}\n(残り ${pData.work_limit - 1} 回)[/info]`);
            }

            if ((/(^|\n)\/catch\b/.test(body) || /(^|\n)\/goal\b/.test(body)) && gambleActive) {
                let iC = /(^|\n)\/catch\b/.test(body);
                if (iC && myJob !== '警察官') return sendTempMessage(roomId, `[info]⚠️ 警察官専用のコマンドです！[/info]`);
                if (!iC && myJob !== 'プロスポーツ選手') return sendTempMessage(roomId, `[info]⚠️ プロスポーツ選手専用のコマンドです！[/info]`);
                if (pData.skill_date === today) return sendTempMessage(roomId, `[info]⚠️ 今日の特殊能力はすでに使用済みです！[/info]`);
                
                let sc = Math.random() < 0.3, e = 0, m = "";
                if (iC) { if(sc){ e=800; m=`見事犯人を逮捕しました！特別報酬 ${e} コイン獲得！🚨`; } else m=`犯人を逃してしまいました...🏃‍♂️💨`; }
                else { if(sc){ e=1000; m=`スーパーゴールを決めました！スポンサーから ${e} コイン獲得！🥅✨`; } else m=`シュートは外れてしまいました...🤦‍♂️`; }
                
                await supabase.from('players').update({ skill_date: today }).eq('account_id', senderId);
                await addMoney(senderId, e); 
                return sendTempMessage(roomId, `[info][title]✨ 特殊能力発動[/title][piconname:${senderId}]\n${m}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && gambleActive) {
                if (pData.slot_count >= 3) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\n本日のスロットは上限(1日3回)に達しました！[/info]`);
                if (Date.now() - Number(pData.last_slot_time || 0) < 600000) return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)}\nスロット休憩中(10分間隔)です！[/info]`);
                
                let bet = sM[2] === 'max' ? myMoney : (sM[2] === 'half' ? Math.floor(myMoney / 2) : parseInt(sM[2], 10));
                
                if (bet > 0 && myMoney >= bet) {
                    await supabase.from('players').update({ money: myMoney - bet, slot_count: pData.slot_count + 1, last_slot_time: Date.now() }).eq('account_id', senderId);
                    
                    let r = Math.random() * 100, omi = (pData.omikuji_date === today) ? pData.omikuji_result : null, oM = "";
                    if(omi === '大吉') { r = Math.max(0, r - 0.4); oM = "(⛩️大吉ボーナス!)"; } 
                    else if(omi === '中吉') { r = Math.max(0, r - 0.2); oM = "(⛩️中吉ボーナス)"; } 
                    else if(omi === '凶') { r += 0.05; } 
                    else if(omi === '大凶') { r += 0.09; }
                    
                    let ml = 0, sy = "", res = "";
                    if(r < 0.1){ ml=100; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (100倍) 🔥"; } 
                    else if(r < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(r < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (3倍)"; } 
                    else if(r < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="(cracker) 当たり！ (2倍)"; } 
                    else if(r < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(r < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = bet * ml; if (wA > 0) await addMoney(senderId, wA);
                    
                    return sendMessage(roomId, `[info][title]🎰 SLOT MACHINE ${oM}[/title]${makeRp(senderId, roomId, msgId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(bet)} ➡ 獲得: ${fNum(wA)} コイン\n(残り回数: ${3 - (pData.slot_count + 1)}回)[/info]`);
                } else return sendTempMessage(roomId, `[info]⚠️ ${makeRp(senderId, roomId, msgId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && gambleActive) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; 
                    if (myMoney < cost) return sendTempMessage(roomId, `[info]⚠️ お金が足りません！(${cnt}枚 = ${fNum(cost)} コイン)[/info]`);
                    
                    const { data: lD } = await supabase.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0; i<10000; i++){ 
                            let s = ((rs+i) % (10000-cnt)) + 1; 
                            let ok = true; 
                            for(let j=0; j<cnt; j++){ if(uN.has(s+j)){ ok=false; break; } } 
                            if(ok){ st=s; break; } 
                        }
                        if(st === -1) return sendTempMessage(roomId, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0; j<cnt; j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1; i<=9999; i++) if(!uN.has(i)) av.push(i);
                        if(av.length < cnt) return sendTempMessage(roomId, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1; i>0; i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } 
                        mN = av.slice(0, cnt);
                    }
                    
                    await supabase.from('players').update({ money: myMoney - cost }).eq('account_id', senderId);
                    for (let n of mN) tks.push({ aid: senderId, num: n });
                    await supabase.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTempMessage(roomId, `[info][title]🎟 宝くじ購入完了[/title][piconname:${senderId}] 様\n宝くじを ${cnt} 枚（${md}）購入しました！\n番号: ${ns}\n\n(※抽選は深夜0時に行われます)[/info]`);
                }
            }

            // --- 🎲 テーブルゲーム (募集・参加・退出・進行) ---
            const { data: lg } = await supabase.from('config').select('value').eq('key', 'last_game_time').single();
            const gCD = (Date.now() - parseInt(lg ? lg.value : 0)) < 180000; // 3分

            if (body.match(/(^|\n)\/(chouhan|cc|derby)\b/) && gambleActive) {
                if (gameState[roomId]) return sendTempMessage(roomId, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                if (gCD) return sendTempMessage(roomId, `[info][title]⚠️ 待機中[/title]ゲームは3分間隔です。もう少しお待ちください。[/info]`);
                
                let t = body.includes('/derby') ? 'derby' : (body.includes('/cc') ? 'cc' : 'chouhan');
                gameState[roomId] = { type: t, state: 'RECRUITING', host: senderId, players: [{ aid: senderId, bet: 0 }] };
                
                let tN = t==='derby' ? "🐎 みんなでダービー" : (t==='cc' ? "🎲 チンチロリン" : "🎲 丁半ゲーム"); 
                let ex = t==='derby' ? "[code]/join derby[/code]" : (t==='cc' ? "[code]/join cc[/code]" : "[code]/join chouhan[/code]");
                
                if (t === 'derby') {
                    let dO = generateDerby(); 
                    gameState[roomId].oddsMap = dO.oddsMap; 
                    gameState[roomId].oddsStr = dO.oddsStr; 
                    gameState[roomId].st = dO.stats;
                }
                
                sendTempMessage(roomId, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${senderId}]\n\n参加者は ${ex} と入力！(現在 1人)\n[hr]※1分経過で自動進行します。[/info]`); 
                startGameTimer(roomId); 
                return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING') {
                if (!gameState[roomId].players.find(x => x.aid === senderId)) { 
                    gameState[roomId].players.push({ aid: senderId, bet: 0 }); 
                    sendMessage(roomId, `[info]🙋‍♂️ [piconname:${senderId}] が参加しました！ (現在 ${gameState[roomId].players.length}人)[/info]`); 
                }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby)/) && gambleActive && gameState[roomId]?.state === 'RECRUITING' && gameState[roomId].host === senderId) {
                if (gameState[roomId].players.length < 2) return sendTempMessage(roomId, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                clearTimeout(gameState[roomId].timeoutId); 
                handleGameTimeout(roomId); 
                return;
            }

            if (body.trim() === '/leave' && gambleActive && gameState[roomId]) {
                let idx = gameState[roomId].players.findIndex(p => p.aid === senderId);
                if (idx !== -1) {
                    let p = gameState[roomId].players[idx]; 
                    gameState[roomId].players.splice(idx, 1);
                    if (p.bet > 0) await addMoney(senderId, p.bet); // 返済チェックなしの単純返金
                    
                    sendTempMessage(roomId, `[info]🚪 [piconname:${senderId}] が退出しました。[/info]`);
                    if (gameState[roomId].players.length === 0) { 
                        clearTimeout(gameState[roomId].timeoutId); 
                        if (gameState[roomId].remindId) clearTimeout(gameState[roomId].remindId);
                        gameState[roomId] = null; 
                        return sendTempMessage(roomId, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); 
                    }
                    checkGameProgress(roomId);
                }
                return;
            }

            // --- 🎲 ゲーム (ベット・アクション) ---
            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && gambleActive && gameState[roomId]?.state === 'BETTING') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && pl.bet === 0) {
                    let b = bM[2] === 'max' ? myMoney : (bM[2] === 'half' ? Math.floor(myMoney/2) : parseInt(bM[2], 10));
                    if (b > 0 && myMoney >= b) {
                        if (gameState[roomId].type === 'derby') {
                            let h = bM[3]; 
                            if (!h || !gameState[roomId].oddsMap[h]) return sendTempMessage(roomId, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください\n例: [code]/bet 100 1-2[/code][/info]`);
                            pl.choice = h;
                        }
                        pl.bet = b; 
                        await supabase.from('players').update({ money: myMoney - b }).eq('account_id', senderId);
                        sendTempMessage(roomId, `[info]💰 [piconname:${senderId}] ${fNum(b)} コインをベットしました！[/info]`);
                        checkGameProgress(roomId);
                    } else sendTempMessage(roomId, `[info]⚠️ ${mkRp(senderId, roomId, msgId)} お金が足りません！[/info]`);
                }
                return;
            }

            if ((body.trim() === '/chou' || body.trim() === '/han') && gambleActive && gameState[roomId]?.type === 'chouhan' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.choice) { 
                    pl.choice = body.trim().slice(1); 
                    sendTempMessage(roomId, `[info]🎯 [piconname:${senderId}] 「${pl.choice==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); 
                    checkGameProgress(roomId); 
                }
            }

            if (body.trim() === '/roll' && gambleActive && gameState[roomId]?.type === 'cc' && gameState[roomId].state === 'ACTION') {
                let pl = gameState[roomId].players.find(x => x.aid === senderId);
                if (pl && !pl.res && senderId !== gameState[roomId].host) {
                    pl.res = getChinchiroRoll(); 
                    sendMsg(roomId, `[info]🎲 [piconname:${senderId}] の出目: ${pl.res.n}[/info]`); 
                    checkGameProgress(roomId);
                }
            }

        } catch (error) { console.error(error); }
    })();
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;
