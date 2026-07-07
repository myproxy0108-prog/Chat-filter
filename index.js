const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (r, res, b) => { r.rawBody = b; } }));

// --- API Client Init ---
const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Global States ---
let isGamble = false;
let localLastReset = null; 
const spams = {};
const gSt = {}; // ゲーム進行状態を一元管理

sb.from('config').select('value').eq('key', 'gamble_active').single().then(r => { if(r.data) isGamble = r.data.value === 'true'; }).catch(()=>{});

// --- Date Utilities ---
const getJST = () => new Date(Date.now() + 9 * 3600000);
const getToday = () => getJST().toISOString().split('T')[0];
const getMonth = () => getJST().toISOString().slice(0, 7);
const fNum = n => Number(n).toLocaleString();

const verify = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    return sig && sig === crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
};

// --- Chatwork Messages ---
const mkRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;
const sendMsg = (rid, txt) => cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`).catch(()=>{});
const sendTemp = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};

// --- Money & Debt Logic ---
const addMoney = async (aid, amt) => {
    const { data } = await sb.from('players').select('*').eq('account_id', aid).single();
    let m = data ? data.money : 0, d = data ? (data.debt || 0) : 0;
    if (d > 0 && amt > 0) { let r = Math.min(d, amt); d -= r; amt -= r; }
    m += amt;
    if (data) await sb.from('players').update({ money: m, debt: d }).eq('account_id', aid);
    else await sb.from('players').insert({ account_id: aid, money: m, debt: d, slot_count: 0, work_limit: 5, msg_count: 0 });
};

// --- Admin & Defense ---
const isAd = async (rid, aid) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const kickTarget = async (rid, aids, act = 'readonly') => {
    try {
        const { data: c } = await cw.get(`/rooms/${rid}/members`);
        let ad = c.filter(m=>m.role==='admin'||m.role==='creator').map(m=>m.account_id.toString());
        let me = c.filter(m=>m.role==='member').map(m=>m.account_id.toString());
        let ro = c.filter(m=>m.role==='readonly').map(m=>m.account_id.toString());
        let found = false;
        for (let a of aids) {
            let id = a.toString();
            if (ad.includes(id) || me.includes(id) || ro.includes(id)) found = true;
            ad = ad.filter(x=>x!==id); me = me.filter(x=>x!==id); ro = ro.filter(x=>x!==id);
            if (act === 'readonly') ro.push(id);
        }
        if (!found) return; 
        const p = new URLSearchParams();
        if (ad.length) p.append('members_admin_ids', ad.join(','));
        if (me.length) p.append('members_member_ids', me.join(','));
        if (ro.length) p.append('members_readonly_ids', ro.join(','));
        await cw.put(`/rooms/${rid}/members`, p.toString());
    } catch(e) {}
};

const checkSpam = (aid) => {
    const now = Date.now();
    if (!spams[aid]) spams[aid] = [];
    spams[aid].push(now);
    spams[aid] = spams[aid].filter(t => now - t <= 5000);
    return (spams[aid].length >= 10);
};

// --- Game Engine ---
const genDerby = () => {
    let st = []; for(let i=0; i<6; i++) st.push(Math.random()*10+1);
    let combos = [], tW = 0, mp = {}, s = "";
    for(let i=1; i<=5; i++){ for(let j=i+1; j<=6; j++){ let w = st[i-1]*st[j-1]; combos.push({c:`${i}-${j}`, w}); tW += w; } }
    combos.forEach(c => { let o = (0.8/(c.w/tW)).toFixed(1); if(o<1.1)o=1.1; if(o>150)o=150.0; mp[c.c] = Number(o); });
    Object.keys(mp).sort((a,b)=>mp[a]-mp[b]).forEach(k => { s += `🐎 ${k} : [b]${mp[k]}倍[/b]\n`; });
    return { mp, s, st };
};

const getRoll = () => {
    for (let i = 0; i < 3; i++) {
        let d = [Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1, Math.floor(Math.random()*6)+1].sort((a,b)=>a-b);
        if(d[0]===1&&d[1]===1&&d[2]===1) return { d, n: "ピンゾロ", r: 6, s: 1, m: 5 };
        if(d[0]===d[1]&&d[1]===d[2]) return { d, n: `${d[0]}の嵐`, r: 5, s: d[0], m: 3 };
        if(d[0]===4&&d[1]===5&&d[2]===6) return { d, n: "シゴロ", r: 4, s: 6, m: 2 };
        if(d[0]===1&&d[1]===2&&d[2]===3) return { d, n: "ヒフミ", r: 0, s: 0, m: -2 };
        if(d[0]===d[1]) return { d, n: `${d[2]}の目`, r: 2, s: d[2], m: 1 };
        if(d[1]===d[2]) return { d, n: `${d[0]}の目`, r: 2, s: d[0], m: 1 };
        if(d[0]===d[2]) return { d, n: `${d[1]}の目`, r: 2, s: d[1], m: 1 };
    }
    return { d: [0,0,0], n: "目なし", r: 1, s: 0, m: 1 };
};

const chkProg = async (rid) => {
    let g = gSt[rid]; if (!g) return;
    if (g.state === 'BET' && g.players.length >= 2 && g.players.every(p => p.bet > 0)) {
        if (g.type === 'db') { clearTimeout(g.tid); await resDerby(rid); }
        else {
            g.state = 'ACT';
            let txt = g.type === 'ch' ? "丁半を予想し、 [b]/chou[/b] (丁) または [b]/han[/b] (半) と発言してください。" : "親以外は [b]/roll[/b] でサイコロを振ってください。";
            await sendTemp(rid, `[info][title]🎲 ゲーム進行[/title]全員のベットが完了しました！\n${txt}\n[hr](※制限時間: 1分)[/info]`);
            startTimer(rid);
        }
    } else if (g.state === 'ACT') {
        if (g.type === 'ch' && g.players.length >= 2 && g.players.every(p => p.choice)) await resChouhan(rid);
        if (g.type === 'cc' && g.players.length >= 2 && g.players.filter(x=>x.aid!==g.host).every(p => p.res)) await resChinchiro(rid);
    }
};

const handleTO = async (rid) => {
    let g = gSt[rid]; if (!g) return;
    if (g.state === 'REC') {
        if (g.players.length >= 2) {
            g.state = 'BET';
            let ex = g.type === 'db' ? `[b]【 🐎 馬連オッズ 】[/b]\n${g.oddsStr}\n[hr]👉 /bet [額] [馬番-馬番] (例: /bet 100 1-2)` : `👉 /bet [額] でベットしてください。`;
            await sendTemp(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。\n\n${ex}\n[hr](※制限1分。 /bet max や /bet half も使えます)[/info]`);
            startTimer(rid);
        } else {
            await sendTemp(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満のため、ゲームを中止します。[/info]`);
            gSt[rid] = null; // 完全リセット
        }
    } else {
        let kick = [], act = [];
        for (let p of g.players) {
            let k = false;
            if (g.state === 'BET' && p.bet === 0) k = true;
            if (g.state === 'ACT' && (g.type === 'ch' && !p.choice || g.type === 'cc' && !p.res && p.aid !== g.host)) k = true;
            if (k) { kick.push(p.aid); if (p.bet > 0) await addMoney(p.aid, p.bet); } else act.push(p);
        }
        g.players = act;
        if (kick.length > 0) await sendTemp(rid, `[info][title]⏳ タイムアウト[/title]時間切れのため、以下のプレイヤーを退出・返金しました。\n${kick.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
        
        if (g.players.length < 2) {
            for (let p of g.players) if (p.bet > 0) await addMoney(p.aid, p.bet);
            await sendTemp(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満になったため中止し、全額返金しました。[/info]`);
            gSt[rid] = null; // 完全リセット
        } else chkProg(rid);
    }
};
const startTimer = (rid, ms = 60000) => { if (gSt[rid]?.tid) clearTimeout(gSt[rid].tid); if (gSt[rid]) gSt[rid].tid = setTimeout(() => handleTO(rid), ms); };

// --- ゲーム精算 ---
const resChinchiro = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let pR = getRoll(); 
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title][b]【 親 ([piconname:${g.host}]) の出目 】[/b]\n[ ${pR.d.join(', ')} ] ➡ 『 ${pR.n} 』\n[hr][b]【 プレイヤー結果 】[/b]\n`;
    for (let p of g.players) {
        if (p.aid === g.host) continue;
        let r = p.res || { r: 1, n: "欠席", m: 1, s: 0, d: [0,0,0] };
        let win = (r.r > pR.r) || (r.r === pR.r && r.s > pR.s), draw = (r.r === pR.r && r.s === pR.s);
        if (draw) { await addMoney(p.aid, p.bet); msg += `😐 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 引き分け (返金)\n`; }
        else if (win) { let m = r.m>0?r.m:1; await addMoney(p.aid, p.bet + (p.bet * m)); msg += `🎉 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ [b]勝利！ (+${fNum(p.bet * m)})[/b]\n`; }
        else { msg += `💀 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 負け...\n`; }
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resChouhan = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let d1 = Math.floor(Math.random()*6)+1, d2 = Math.floor(Math.random()*6)+1, s = d1+d2, ans = (s%2===0)?'chou':'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${s}) ➡ 『 [b]${ans==='chou'?'丁(偶数)':'半(奇数)'}[/b] 』\n[hr][b]【 プレイヤー結果 】[/b]\n`;
    for (let p of g.players) {
        if (p.choice === ans) { await addMoney(p.aid, p.bet*2); msg += `🎉 [piconname:${p.aid}]: 的中！ (+${fNum(p.bet*2)} コイン)\n`; }
        else msg += `💀 [piconname:${p.aid}]: 予想[${p.choice==='chou'?'丁':'半'}] ➡ はずれ...\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resDerby = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let st = g.st, ws = [...st], tW = ws.reduce((a,b)=>a+b,0);
    let r1 = Math.random() * tW, s1 = 0, f = 1;
    for(let i=0; i<6; i++){ s1+=ws[i]; if(r1<=s1){ f=i+1; break; } }
    ws[f-1] = 0; tW = ws.reduce((a,b)=>a+b,0);
    let r2 = Math.random() * tW, s2 = 0, s = 1;
    for(let i=0; i<6; i++){ s2+=ws[i]; if(r2<=s2){ s=i+1; break; } }
    
    let winC = f < s ? `${f}-${s}` : `${s}-${f}`, odd = g.oddsMap[winC];
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${f} 】番と【 ${s} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 [b]${winC}[/b] 】 (${odd}倍)\n[hr][b]【 プレイヤー結果 】[/b]\n`;
    for(let p of g.players){
        if(p.choice === winC){ let w = Math.floor(p.bet * odd); await addMoney(p.aid, p.bet + w); msg += `🎉 [piconname:${p.aid}]: 的中！ (+${fNum(w)} コイン)\n`; }
        else msg += `💀 [piconname:${p.aid}]: 予想[${p.choice}] ➡ はずれ...\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

// --- Webhook メイン ---
app.post('/webhook', (req, res) => {
    if (!verify(req)) return res.status(401).send();
    res.status(200).send('OK'); 
    
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const rid = ev.room_id, body = ev.body || "", sId = ev.account_id.toString(), mId = ev.message_id;
    const today = getToday(), tMonth = getMonth();

    (async () => {
        try {
            // 返信タグ完全対応
            const rpM = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const rAid = rpM ? rpM[1] : null;

            // 1. ブラックリスト判定
            const { data: isB } = await sb.from('blacklist').select('*').eq('account_id', sId).single();
            if (isB) { await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }

            // 2. スパム検知 (管理者は無効)
            if (checkSpam(sId) && !(await isAd(rid, sId))) {
                await kickTarget(rid, [sId], 'readonly');
                return sendTemp(rid, `[info][title]⚠️ 警告[/title][piconname:${sId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 3. 日付更新 ＆ 宝くじ抽選
            if (localLastReset !== today) {
                const { data: ld } = await sb.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!ld || ld.value !== today) {
                    await sb.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null, omikuji_date: null }).neq('account_id', '0');
                    await sb.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastReset = today;
                    let m = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\nスロット回数、おみくじ、お仕事制限がリセットされました！\n[hr]`;
                    
                    const { data: tData } = await sb.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = tData ? JSON.parse(tData.value) : [];
                    if (tks.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        m += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 [b]${win}[/b] 】です！\n[hr]`;
                        let pays = {}, wns = [];
                        const chP = (n, w) => {
                            if(n===w) return {p:30000, n:'🥇1等'}; let pr=w-1<1?9999:w-1, nx=w+1>9999?1:w+1;
                            if(n===pr||n===nx) return {p:15000, n:'🥈前後賞'};
                            if(n%1000===w%1000) return {p:10000, n:'🥈2等'}; if(n%100===w%100) return {p:5000, n:'🥉3等'}; if(n%10===w%10) return {p:1000, n:'🏅4等'}; return null;
                        };
                        for (let t of tks) { let r = chP(t.num, win); if(r){ wns.push({a:t.aid, num:t.num, ...r}); pays[t.aid]=(pays[t.aid]||0)+r.p; } }
                        if (wns.length > 0) {
                            for (let a in pays) await addMoney(a, pays[a]);
                            wns.sort((a,b)=>b.p-a.p); for(let w of wns.slice(0,20)) m += `✨ [piconname:${w.a}]: 予想[${w.num}] ➡ ${w.n} (+${fNum(w.p)} コイン)\n`;
                            if(wns.length>20) m += `...他 ${wns.length-20} 件の当選！\n`;
                        } else m += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`;
                        await sb.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMsg(rid, m + `[/info]`);
                }
            }

            // 4. データ取得 & サイレント仕事回復
            let { data: p } = await sb.from('players').select('*').eq('account_id', sId).single();
            if (!p && gambleActive && !body.startsWith('/')) {
                await sb.from('players').insert({ account_id: sId, money: 0, debt: 0, work_limit: 5, msg_count: 1 });
                p = { money: 0, debt: 0, work_limit: 5, msg_count: 1, job: 'サラリーマン' };
            }
            if (isGamble && p && !body.startsWith('/')) {
                let mc = (p.msg_count || 0) + 1; let wl = p.work_limit || 5;
                if (mc >= (Math.floor(Math.random()*21)+30)) { mc = 0; if(wl < 10) wl++; }
                await sb.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', sId);
            }

            let myM = p?p.money:0, myD = p?(p.debt||0):0, myJ = p?(p.job||'サラリーマン'):'サラリーマン', cDebt = (p&&p.debt_month===tMonth)?(p.monthly_debt||0):0;

            // --- 📖 ヘルプ ---
            if (body === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内 (V35 FINAL)[/title]
[b]🏦 銀行・ステータス[/b]
・ /status : 状態確認
・ /give [金額] : 相手に送金 (税10%)
・ /debt [金額] : 借金 (月上限5000)
・ /money-rank : 純資産ランキング

[b]💼 職業・スキル[/b]
・ /job : 転職と求人
・ /work : 職業給料 (10分に1回, 1日5回上限)
・ /catch または /goal : 職業専用能力
・ /omikuji : 1日1回おみくじ (スロット確率変動)

[b]🎰 カジノ・宝くじ[/b]
・ /slot [掛金|max|half] : スロット (1日3回)
・ /buy-lot [連番|バラ] [枚数] : 宝くじ

[b]🎲 テーブルゲーム (3分間隔)[/b]
・ /chouhan : 丁半ゲーム募集
・ /cc : チンチロリン募集 (/roll でサイコロ)
・ /derby : ダービー募集 (/bet [額] [馬連])

[b]👑 管理者専用[/b]
・ /take [金] : 特別資金付与
・ /st-gya, /fi-gya : 有効/無効化
・ /blacklist, /reblacklist, /remove-rank[/info]`;
                return sendTemp(rid, h, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && isGamble && await isAd(rid, sId)) {
                let a = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/)||[])[2]||(body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                let tg = rAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if(tg && a>0){ await addMoney(tg, a); return sendTemp(rid, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${tg}] 様へ [b]${fNum(a)}[/b] コインを付与しました。[/info]`); }
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body) && await isAd(rid, sId)) {
                let tg = rAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if(!tg && cmd !== 'add') return; if(!tg && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: eD } = await sb.from('config').select('value').eq('key','rank_excluded').single();
                    let ex = eD ? JSON.parse(eD.value) : [];
                    if (ex.includes(tg)) { ex = ex.filter(i=>i!==tg); sendTemp(rid, `[info][title]設定完了[/title][piconname:${tg}] 様のランキング除外を解除しました。[/info]`); }
                    else { ex.push(tg); sendTemp(rid, `[info][title]設定完了[/title][piconname:${tg}] 様をランキングから除外しました。[/info]`); }
                    return await sb.from('config').upsert({key:'rank_excluded', value:JSON.stringify(ex)});
                }
                if (cmd === 'add') { await sb.from('blacklist').insert({account_id:tg}); await kickTarget(rid,[tg],'readonly'); return sendTemp(rid, `[info][title]🚫 追放完了[/title][piconname:${tg}] をブラックリストに登録し、権限を「閲覧のみ」に変更しました。[/info]`); }
                else if (cmd === 'remove') { await sb.from('blacklist').delete().eq('account_id',tg); return sendTemp(rid, `[info][title]✅ 解除完了[/title][piconname:${tg}] の追放状態を解除しました。[/info]`); }
                else if (cmd === 'list') { const { data:ls } = await sb.from('blacklist').select('account_id'); return sendTemp(rid, `[info][title]📜 BL一覧[/title]${ls&&ls.length?ls.map(d=>`[piconname:${d.account_id}]`).join('\n'):'なし'}\n[hr]※1分後に自動消滅[/info]`); }
            }

            if (body.startsWith('/st-gya') && await isAd(rid,sId)){ isGamble=true; await sb.from('config').upsert({key:'gamble_active',value:'true'}); return sendMsg(rid, `[info][title]🎰 カジノ＆ライフ[/title]システムが【 有効 】になりました！[/info]`); }
            if (body.startsWith('/fi-gya') && await isAd(rid,sId)){ isGamble=false; await sb.from('config').upsert({key:'gamble_active',value:'false'}); return sendMsg(rid, `[info][title]🚫 カジノ＆ライフ[/title]システムが【 停止 】しました。[/info]`); }

            // --- ⛩️ おみくじ ---
            if (/(^|\n)\/omikuji\b/.test(body) && isGamble) {
                if (p && p.omikuji_date === today) return sendTemp(rid, `[info][title]⚠️ おみくじ[/title]${mkRp(sId, rid, mId)}\n本日のおみくじは既に引いています。\n(結果: ${p.omikuji_result})[/info]`);
                let r = Math.random() * 100, res = "", eff = "";
                if(r<10) { res="大吉"; eff="✨ スロットの当たり確率が大幅UP！"; } else if(r<30) { res="中吉"; eff="🌟 スロットの当たり確率が少しUP！"; } else if(r<60) { res="小吉"; eff="🎯 スロット確率は通常通り。"; } else if(r<85) { res="吉"; eff="🎯 スロット確率は通常通り。"; } else if(r<95) { res="凶"; eff="💧 スロットの当たり確率が少しDOWN..."; } else { res="大凶"; eff="💀 スロットの当たり確率が大幅DOWN..."; }
                
                if (p) await sb.from('players').update({ omikuji_date: today, omikuji_result: res }).eq('account_id', sId);
                else await sb.from('players').insert({ account_id: sId, money: 0, debt: 0, omikuji_date: today, omikuji_result: res });
                return sendMsg(rid, `[info][title]⛩️ おみくじ結果[/title]${mkRp(sId, rid, mId)}\n[hr]あなたの今日の運勢は...【 [b]${res}[/b] 】です！\n\n${eff}[/info]`);
            }

            // --- 🏦 銀行関連 ---
            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (dbM && isGamble) {
                let a = parseInt(dbM[2], 10);
                if (a > 0) {
                    if (cDebt + a > 5000) return sendTemp(rid, `[info][title]⚠️ 借金上限エラー[/title]${mkRp(sId,rid,mId)}\n1ヶ月の借金上限(5000)を超過します！\n(今月は既に ${cDebt} コイン借りています)[/info]`);
                    if (p) await sb.from('players').update({money:myM+a, debt:myD+a, monthly_debt:cDebt+a, debt_month:tMonth}).eq('account_id',sId);
                    else await sb.from('players').insert({account_id:sId, money:a, debt:a, monthly_debt:a, debt_month:tMonth});
                    return sendTemp(rid, `[info][title]💳 お借り入れ完了[/title][piconname:${sId}] 様\n[b]${fNum(a)}[/b] コインを借金しました。\n[hr]今月の借金可能枠: 残り ${fNum(5000 - (cDebt + a))} コイン[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && isGamble) {
                let tg = rAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/)||[])[2];
                let a = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/)||[])[2]||(body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/)||[])[3], 10);
                if (tg && a > 0) {
                    let av = Math.max(0, myM - myD); if (av < a) return sendTemp(rid, `[info][title]⚠️ 送金エラー[/title]${mkRp(sId,rid,mId)}\n送金枠(純資産)が不足しています！\n(借金があるため、送金可能額は ${fNum(av)} コインのみです)[/info]`);
                    let tx = Math.floor(a * 0.10), rA = a - tx;
                    await sb.from('players').update({money: myM - a}).eq('account_id', sId);
                    const {data:rc} = await sb.from('players').select('*').eq('account_id',tg).single();
                    if(rc) await sb.from('players').update({money:rc.money+rA}).eq('account_id',tg); else await sb.from('players').insert({account_id:tg, money:rA, debt:0});
                    return sendTemp(rid, `[info][title]🎁 送金完了[/title][piconname:${sId}] ➡ [piconname:${tg}]\n[b]${fNum(a)}[/b] コインを送金しました。\n[hr]※システム税(-${fNum(tx)} コイン)が引かれ、相手には ${fNum(rA)} コインが届きました。[/info]`);
                }
            }

            if (body.trim() === '/status') {
                let omi = (p && p.omikuji_date === today && p.omikuji_result) ? `\n⛩️ 今日の運勢: ${p.omikuji_result}` : "";
                return sendTemp(rid, `[info][title]📊 プレイヤー情報[/title][piconname:${sId}] 様\n\n💰 所持金: ${fNum(myM)} コイン${myD>0?`\n💳 借金: -${fNum(myD)} コイン`:''}\n💎 純資産: ${fNum(myM - myD)} コイン\n[hr]👔 職業: ${myJ}\n🎰 スロット残り: ${Math.max(0,3-(p?p.slot_count:0))} 回\n💼 お仕事残り: ${p?p.work_limit:0} 回${omi}\n[hr]※1分後に自動消滅します[/info]`);
            }
            if (body.trim() === '/money-rank') {
                const { data: exD } = await sb.from('config').select('value').eq('key','rank_excluded').single(); let eI = exD?JSON.parse(exD.value):[];
                const { data: ls } = await sb.from('players').select('*'); let f = ls?ls.filter(d=>!eI.includes(d.account_id)):[];
                f.sort((a,b)=>((b.money||0)-(b.debt||0))-((a.money||0)-(a.debt||0)));
                let s = f.slice(0,10).map((d,i)=>{let n=(d.money||0)-(d.debt||0); let md=i===0?"🥇":(i===1?"🥈":(i===2?"🥉":"🔹")); return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: [b]${fNum(n)}[/b] コイン ${d.debt>0?`(所持:${fNum(d.money)} 借金:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;}).join('\n[hr]');
                return sendTemp(rid, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※このメッセージは5分後に自動消滅します[/info]`, 300000);
            }

            // --- 💼 職業 ---
            const jM = body.match(/(^|\n)\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (jM && isGamble) {
                const jn = jM[2]; const cs = {'サラリーマン':0, '公務員':2000, '警察官':3000, 'プロスポーツ選手':5000};
                if (myJ === jn) return sendTemp(rid, `[info]⚠️ ${mkRp(sId,rid,mId)}\nすでに ${jn} に就いています！[/info]`);
                if (myM < cs[jn]) return sendTemp(rid, `[info]⚠️ ${mkRp(sId,rid,mId)}\nお金が足りません！(転職費用: ${fNum(cs[jn])} コイン)[/info]`);
                if (p) await sb.from('players').update({job:jn, money:myM-cs[jn]}).eq('account_id',sId); else await sb.from('players').insert({account_id:sId, job:jn, money:-cs[jn]});
                return sendTemp(rid, `[info][title]🎉 転職完了[/title][piconname:${sId}] 様\n本日より「${jn}」としてご活躍ください！ (-${fNum(cs[jn])} コイン)[/info]`);
            } else if (body.trim() === '/job' && isGamble) return sendTemp(rid, `[info][title]💼 ハローワーク (求人一覧)[/title]👨‍💼 [b]サラリーマン[/b] (費用: 0)\n ▶ /work (100〜500) ※10%でミス0\n\n🏛️ [b]公務員[/b] (費用: 2000)\n ▶ /work (300〜500)\n\n🚓 [b]警察官[/b] (費用: 3000)\n ▶ /work (300〜700) /catch (30%で800)\n\n⚽ [b]プロスポーツ選手[/b] (費用: 5000)\n ▶ /work (500〜1000) /goal (30%で1000)\n[hr]※転職コマンド: /job 役職名[/info]`);

            if (/(^|\n)\/work\b/.test(body) && isGamble) {
                if (!p) { await sb.from('players').insert({account_id:sId, money:0, debt:0, work_limit:5}); p = {money:0, debt:0, job:'サラリーマン', work_limit:5, last_work_time:0}; }
                let wl = p.work_limit ?? 5; let lwt = Number(p.last_work_time || 0);
                if (wl <= 0) return sendTemp(rid, `[info][title]⚠️ 上限到達[/title]${mkRp(sId,rid,mId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                if (Date.now() - lwt < 600000) { let rem = Math.ceil((600000-(Date.now()-lwt))/60000); return sendTemp(rid, `[info][title]⚠️ 休憩中[/title]${mkRp(sId,rid,mId)}\n次の仕事まであと約 ${rem} 分お待ちください。[/info]`); }
                
                let e=0, m="";
                if(myJ==='サラリーマン'){ if(Math.random()<0.1){e=0;m="仕事で重大なミスをしてしまい、本日の給料は [b]0 コイン[/b] になりました...😭";} else {e=Math.floor(Math.random()*401)+100;m=`真面目に働き、[b]${fNum(e)} コイン[/b] 稼ぎました！💼`;} }
                else if(myJ==='公務員'){ e=Math.floor(Math.random()*201)+300; m=`安定した仕事をこなし、[b]${fNum(e)} コイン[/b] 稼ぎました！🏛️`; }
                else if(myJ==='警察官'){ e=Math.floor(Math.random()*401)+300; m=`街の平和を守り、[b]${fNum(e)} コイン[/b] 稼ぎました！🚓`; }
                else if(myJ==='プロスポーツ選手'){ e=Math.floor(Math.random()*501)+500; m=`試合で大活躍し、[b]${fNum(e)} コイン[/b] 稼ぎました！⚽`; }
                
                await sb.from('players').update({last_work_time:Date.now(), work_limit:wl-1}).eq('account_id',sId);
                await addMoney(sId, e); return sendTemp(rid, `[info][title]💼 お仕事完了[/title][piconname:${sId}] 様\n\n${m}\n[hr]残り仕事回数: ${wl-1} 回[/info]`);
            }

            if ((/(^|\n)\/catch\b/.test(body) || /(^|\n)\/goal\b/.test(body)) && isGamble && p) {
                let iC = /(^|\n)\/catch\b/.test(body);
                if (iC && myJ !== '警察官') return sendTemp(rid, `[info]⚠️ 警察官専用のコマンドです！[/info]`); if (!iC && myJ !== 'プロスポーツ選手') return sendTemp(rid, `[info]⚠️ プロスポーツ選手専用のコマンドです！[/info]`);
                if (p.skill_date === today) return sendTemp(rid, `[info]⚠️ ${mkRp(sId,rid,mId)}\n今日の特殊能力はすでに使用済みです！[/info]`);
                let sc = Math.random() < 0.3, e = 0, m = "";
                if (iC) { if(sc){e=800;m=`見事犯人を逮捕しました！\n特別報酬 [b]${e} コイン[/b] 獲得！🚨`;} else m=`犯人を逃してしまいました...🏃‍♂️💨`; }
                else { if(sc){e=1000;m=`スーパーゴールを決めました！\nスポンサーから [b]${e} コイン[/b] 獲得！🥅✨`;} else m=`シュートは外れてしまいました...🤦‍♂️`; }
                await sb.from('players').update({skill_date:today}).eq('account_id',sId);
                await addMoney(sId, e); return sendTemp(rid, `[info][title]✨ 特殊能力発動[/title][piconname:${sId}] 様\n\n${m}[/info]`);
            }

            // --- 🎰 スロット ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && isGamble && p) {
                if (p.slot_count >= 3) return sendTemp(rid, `[info]⚠️ ${mkRp(sId,rid,mId)}\n本日のスロットは上限(1日3回)に達しました！[/info]`);
                if (Date.now() - Number(p.last_slot_time||0) < 600000) return sendTemp(rid, `[info]⚠️ ${mkRp(sId,rid,mId)}\nスロット休憩中(10分間隔)です！[/info]`);
                let bet = sM[2]==='max'?mM:(sM[2]==='half'?Math.floor(mM/2):parseInt(sM[2],10));
                
                if (bet > 0 && mM >= bet) {
                    await sb.from('players').update({money:mM-bet, slot_count:p.slot_count+1, last_slot_time:Date.now()}).eq('account_id',sId);
                    
                    let rand = Math.random() * 100, r = rand;
                    let omi = (p.omikuji_date === today) ? p.omikuji_result : null, omiMsg = "";
                    if(omi==='大吉'){ r = Math.max(0, r - 0.4); omiMsg = "(⛩️大吉ボーナス!)"; } else if(omi==='中吉'){ r = Math.max(0, r - 0.2); omiMsg = "(⛩️中吉ボーナス)"; } else if(omi==='凶'){ r += 0.05; } else if(omi==='大凶'){ r += 0.09; }
                    
                    let ml=0, sy="", res="";
                    if(r < 0.1){ ml=100; sy="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (100倍) 🔥"; } 
                    else if(rand < 3.1){ ml=10; sy="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍) ✨"; } 
                    else if(rand < 9.1){ ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="🎉 当たり！ (3倍)"; } 
                    else if(rand < 19.1){ ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sy=`${s} | ${s} | ${s}`; res="🎉 当たり！ (2倍)"; } 
                    else if(rand < 29.1){ ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sy=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if(rand < 49.1){ ml=2; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sy=a.join(" | "); res="🍒 チェリー出現！ (2倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sy=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    
                    let wA = bet * ml; if (wA > 0) await addMoney(sId, wA);
                    return sendMsg(rid, `[info][title]🎰 SLOT MACHINE ${omiMsg}[/title]${mkRp(sId,rid,mId)}\n[hr]　▶ [ ${sy} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(bet)} ➡ 獲得: [b]${fNum(wA)}[/b] コイン\n(残り回数: ${3-(p.slot_count+1)}回)[/info]`);
                } else return sendTemp(rid, `[info]⚠️ ${mkRp(sId,rid,mId)} お金が足りません！[/info]`);
            }

            // --- 🎟️ 宝くじ ---
            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ|)\s*([0-9]+)?/);
            if (lM && isGamble) {
                let md = lM[2] || 'バラ', cnt = lM[3] ? parseInt(lM[3], 10) : 1;
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; if(myM < cost) return sendTemp(rid, `[info]⚠️ お金が足りません！(${cnt}枚 = ${fNum(cost)} コイン)[/info]`);
                    const {data:lD} = await sb.from('config').select('value').eq('key','lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : [], uN = new Set(tks.map(t=>t.num)), mN = [];
                    if (md === '連番') {
                        let st=-1, rs=Math.floor(Math.random()*(10000-cnt))+1;
                        for(let i=0;i<10000;i++){ let s=((rs+i)%(10000-cnt))+1; let ok=true; for(let j=0;j<cnt;j++){ if(uN.has(s+j)){ok=false;break;} } if(ok){st=s;break;} }
                        if(st===-1) return sendTemp(rid, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0;j<cnt;j++) mN.push(st+j);
                    } else {
                        let av=[]; for(let i=1;i<=9999;i++) if(!uN.has(i)) av.push(i);
                        if(av.length<cnt) return sendTemp(rid, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1;i>0;i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; } mN=av.slice(0,cnt);
                    }
                    await sb.from('players').update({money:myM-cost}).eq('account_id',sId);
                    for(let n of mN) tks.push({aid:sId,num:n}); await sb.from('config').upsert({key:'lottery_tickets',value:JSON.stringify(tks)});
                    let ns = mN.length>5 ? mN.slice(0,5).join(', ')+` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTemp(rid, `[info][title]🎟 宝くじ購入完了[/title][piconname:${sId}] 様\n宝くじを ${cnt} 枚（${md}）購入しました！\n番号: [b]${ns}[/b]\n[hr]※抽選は深夜0時に行われます[/info]`);
                }
            }

            // --- 🎲 ゲーム共通 (募集・参加・開始・退出) ---
            const isGameActive = (rid) => gSt[rid] && gSt[rid].state !== 'IDLE';
            const { data: lg } = await sb.from('config').select('value').eq('key', 'last_game_time').single();
            const gCD = (Date.now() - parseInt(lg ? lg.value : 0)) < 180000;

            if (body.match(/(^|\n)\/(chouhan|cc|derby)\b/) && isGamble) {
                if (isGameActive(rid)) return sendTemp(rid, `[info][title]⚠️ エラー[/title]現在、別のゲームが進行中です。終了までお待ちください。[/info]`);
                if (gCD) return sendTemp(rid, `[info][title]⚠️ 待機中[/title]ゲームは3分間隔です。もう少しお待ちください。[/info]`);
                
                let t = body.includes('/derby')?'db':(body.includes('/cc')?'cc':'ch');
                gSt[rid] = { type: t, state: 'RECRUITING', host: sId, players: [{aid:sId, bet:0}], oddsMap: {}, oddsStr: "", st: [] };
                
                let tN = t==='db'?"🐎 ダービー":(t==='cc'?"🎲 チンチロリン":"🎲 丁半ゲーム"); let ex = t==='db'?"/join derby":(t==='cc'?"/join cc":"/join chouhan");
                if (t==='db') { let dO=genDerby(); gSt[rid].oddsMap=dO.mp; gSt[rid].oddsStr=dO.s; gSt[rid].st=dO.st; }
                
                sendTemp(rid, `[info][title]${tN} 募集開始[/title]ホスト: [piconname:${sId}]\n\n参加者は [b]${ex}[/b] と入力！(現在 1人)\n[hr]※1分経過で自動進行します。[/info]`); 
                startTimer(rid); return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby)/) && isGamble && gSt[rid]?.state === 'RECRUITING') {
                if (!gSt[rid].players.find(x=>x.aid===sId)) { 
                    gSt[rid].players.push({aid:sId, bet:0}); 
                    sendMsg(rid, `[info]🙋‍♂️ [piconname:${sId}] が参加しました！ (現在 ${gSt[rid].players.length}人)[/info]`); 
                }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby)/) && isGamble && gSt[rid]?.state === 'RECRUITING' && gSt[rid].host === sId) {
                if (gSt[rid].players.length < 2) return sendTemp(rid, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                clearTimeout(gSt[rid].tid); handleTO(rid); return;
            }

            if (body.trim() === '/leave' && isGamble && isGameActive(rid)) {
                let idx = gSt[rid].players.findIndex(p => p.aid === sId);
                if (idx !== -1) {
                    let p = gSt[rid].players[idx]; gSt[rid].players.splice(idx, 1);
                    if (p.bet > 0) await addMoney(sId, p.bet);
                    sendTemp(rid, `[info]🚪 [piconname:${sId}] が退出しました。[/info]`);
                    if (gSt[rid].players.length === 0) { clearTimeout(gSt[rid].tid); gSt[rid]=null; return sendTemp(rid, `[info]⚠️ 参加者がいなくなったため、ゲームを中止します。[/info]`); }
                    chkProg(rid);
                }
                return;
            }

            // --- 🎲 ゲーム (ベットとアクション) ---
            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && isGamble && gSt[rid]?.state === 'BETTING') {
                let pl = gSt[rid].players.find(x=>x.aid===sId);
                if (pl && pl.bet === 0) {
                    let b = bM[2]==='max'?myM:(bM[2]==='half'?Math.floor(myM/2):parseInt(bM[2],10));
                    if (b > 0 && myM >= b) {
                        if (gSt[rid].type === 'db') {
                            let h = bM[3]; if(!h || !gSt[rid].oddsMap[h]) return sendTemp(rid, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください\n例: /bet 100 1-2[/info]`);
                            pl.choice = h;
                        }
                        pl.bet = b; await sb.from('players').update({money:myM-b}).eq('account_id',sId);
                        sendTemp(rid, `[info]💰 [piconname:${sId}] [b]${fNum(b)}[/b] コインをベットしました！[/info]`);
                        chkProg(rid);
                    } else sendTemp(rid, `[info]⚠️ ${mkRp(sId,rid,mId)} お金が足りません！[/info]`);
                }
                return;
            }

            if ((body.trim()==='/chou'||body.trim()==='/han') && isGamble && gSt[rid]?.type==='ch' && gSt[rid].state==='ACTION') {
                let pl = gSt[rid].players.find(x=>x.aid===sId);
                if (pl && !pl.choice) { pl.choice = body.trim().slice(1); sendTemp(rid, `[info]🎯 [piconname:${sId}] 「${pl.choice==='chou'?'丁(偶数)':'半(奇数)'}」を選択しました！[/info]`); chkProg(rid); }
            }

            if (body.trim()==='/roll' && isGamble && gSt[rid]?.type==='cc' && gSt[rid].state==='ACTION') {
                let pl = gSt[rid].players.find(x=>x.aid===sId);
                if (pl && !pl.res && sId !== gSt[rid].host) {
                    pl.res = getRoll(); sendMsg(rid, `[info]🎲 [piconname:${sId}] の出目: [b]${pl.res.n}[/b][/info]`); chkProg(rid);
                }
            }

        } catch (e) { console.error(e); }
    })();
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;
