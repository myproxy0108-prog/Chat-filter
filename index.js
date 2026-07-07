const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const cw = axios.create({
    baseURL: 'https://api.chatwork.com/v2',
    headers: { 'X-ChatWorkToken': process.env.CHATWORK_API_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }
});
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

let isGamble = false;
let localLastReset = null; 
const spams = {};
const gSt = {}; 

sb.from('config').select('value').eq('key', 'gamble_active').single().then(r => { if(r.data) isGamble = r.data.value === 'true'; }).catch(()=>{});

const getJST = () => new Date(Date.now() + 9 * 3600000);
const getToday = () => getJST().toISOString().split('T')[0];
const getMonth = () => getJST().toISOString().slice(0, 7);
const fNum = (n) => Number(n).toLocaleString();

const verify = (req) => {
    const sig = req.headers['x-chatworkwebhooksignature'];
    return sig && sig === crypto.createHmac('sha256', Buffer.from(process.env.CHATWORK_WEBHOOK_TOKEN, 'base64')).update(req.rawBody).digest('base64');
};

const sendTemp = async (rid, txt, ms = 60000) => {
    try {
        const res = await cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`);
        if (res?.data?.message_id) setTimeout(() => cw.delete(`/rooms/${rid}/messages/${res.data.message_id}`).catch(()=>{}), ms);
    } catch(e) {}
};
const sendMsg = (rid, txt) => cw.post(`/rooms/${rid}/messages`, `body=${encodeURIComponent(txt)}`).catch(()=>{});
const mkRp = (aid, rid, mid) => `[rp aid=${aid} to=${rid}-${mid}]`;

const addMoney = async (aid, amt) => {
    const { data } = await sb.from('players').select('*').eq('account_id', aid).single();
    let m = data ? data.money : 0, d = data ? (data.debt || 0) : 0;
    if (d > 0 && amt > 0) { let r = Math.min(d, amt); d -= r; amt -= r; }
    m += amt;
    if (data) await sb.from('players').update({ money: m, debt: d }).eq('account_id', aid);
    else await sb.from('players').insert({ account_id: aid, money: m, debt: d });
};

const isAdmin = async (rid, aid) => {
    try {
        const { data } = await cw.get(`/rooms/${rid}/members`);
        const m = data.find(x => x.account_id.toString() === aid.toString());
        return m && (m.role === 'admin' || m.role === 'creator');
    } catch(e) { return false; }
};

const changeRole = async (rid, aids, act = 'readonly') => {
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

// --- ゲームエンジン ---
const genDerby = () => {
    let st = []; for(let i=1;i<=6;i++) st.push(Math.random()*10+1);
    let tot=0, combos=[];
    for(let i=1;i<=5;i++){ for(let j=i+1;j<=6;j++){ let w=st[i-1]*st[j-1]; combos.push({m1:i,m2:j,w}); tot+=w; } }
    let oddsMap = {}, oddsStr = "";
    combos.forEach(c => {
        let odd = (0.9 / (c.w/tot)).toFixed(1);
        if(odd<1.1) odd=1.1; if(odd>100) odd=100.0;
        oddsMap[`${c.m1}-${c.m2}`] = Number(odd);
    });
    Object.keys(oddsMap).sort((a,b)=>oddsMap[a]-oddsMap[b]).forEach(k => { oddsStr += `🐎 ${k} : ${oddsMap[k]}倍\n`; });
    return { oddsMap, oddsStr, st };
};

const chkProg = async (rid) => {
    let g = gSt[rid]; if (!g || g.state === 'IDLE') return;
    if (g.state === 'BETTING' && g.players.length >= 2 && g.players.every(p => p.bet > 0)) {
        if (g.type === 'db') { clearTimeout(g.tid); await resolveDerby(rid); }
        else {
            g.state = 'ACTION';
            if (g.type === 'ch') await sendTemp(rid, `[info][title]🎲 丁半 選択フェーズ[/title]全員のベットが完了しました！\n/chou (丁) または /han (半) を予想してください。\n(※制限1分)[/info]`);
            else if (g.type === 'cc') await sendTemp(rid, `[info][title]🎲 チンチロ 振るフェーズ[/title]全員のベットが完了しました！\n親(ホスト)以外の人は /roll でサイコロを振ってください。\n(※制限1分)[/info]`);
            startTimer(rid);
        }
    } else if (g.state === 'ACTION') {
        if (g.type === 'ch' && g.players.length >= 2 && g.players.every(p => p.choice)) await resolveChouhan(rid);
        if (g.type === 'cc' && g.players.length >= 2 && g.players.filter(x=>x.aid!==g.host).every(p => p.res)) await resolveChinchiro(rid);
    }
};

const handleTO = async (rid) => {
    let g = gSt[rid]; if (!g || g.state === 'IDLE') return;
    if (g.state === 'RECRUITING') {
        if (g.players.length >= 2) {
            g.state = 'BETTING';
            let ex = g.type === 'db' ? `\n[b]【 🐎 馬連オッズ 】[/b]\n${g.oddsStr}\n[hr]👉 /bet [額] [馬1]-[馬2] (例: /bet 100 1-2) で賭けてください！` : `\n👉 /bet [掛け金] でベットしてください。`;
            await sendTemp(rid, `[info][title]⏳ 募集終了・ゲーム開始[/title]参加者が確定しました。${ex}\n(※制限1分。 /bet max や /bet half も使えます)[/info]`);
            startTimer(rid);
        } else {
            await sendTemp(rid, `[info][title]⚠️ ゲーム中止[/title]参加者が2人未満のため、ゲームを中止します。[/info]`);
            gSt[rid] = null;
        }
    } else {
        let kick = [], act = [];
        for (let p of g.players) {
            let k = false;
            if (g.state === 'BETTING' && p.bet === 0) k = true;
            if (g.state === 'ACTION') {
                if (g.type === 'ch' && !p.choice) k = true;
                if (g.type === 'cc' && !p.res && p.aid !== g.host) k = true;
            }
            if (k) { kick.push(p.aid); if (p.bet > 0) await addMoney(p.aid, p.bet); } else act.push(p);
        }
        g.players = act;
        if (kick.length > 0) await sendTemp(rid, `[info]⏳ タイムアウトにより以下の方を退出・返金しました。\n${kick.map(a=>`[piconname:${a}]`).join(' ')}[/info]`);
        
        if (g.players.length < 2) {
            for (let p of g.players) if (p.bet > 0) await addMoney(p.aid, p.bet);
            await sendTemp(rid, `[info][title]⚠️ ゲーム中止[/title]残りの参加者が2人未満になったため中止し、全額返金しました。[/info]`);
            gSt[rid] = null;
        } else chkProg(rid);
    }
};

const startTimer = (rid, ms = 900000) => {
    if (gSt[rid]?.tid) clearTimeout(gSt[rid].tid);
    if (gSt[rid]) gSt[rid].tid = setTimeout(() => handleTO(rid), ms);
};

const getRoll = () => {
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

const resolveChinchiro = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let pRoll = getRoll(); 
    let msg = `[info][title]🎲 チンチロリン 結果発表[/title][b]【 親 ([piconname:${g.host}]) の出目 】[/b]\n[ ${pRoll.d.join(', ')} ] ➡ 『 ${pRoll.n} 』\n[hr][b]【 プレイヤー結果 】[/b]\n`;
    for (let p of g.players) {
        if (p.aid === g.host) continue;
        let r = p.res || { r: 1, n: "欠席", m: 1, s: 0, d: [0,0,0] };
        let win = (r.r > pRoll.r) || (r.r === pRoll.r && r.s > pRoll.s);
        let draw = (r.r === pRoll.r && r.s === pRoll.s);
        if (draw) { await addMoney(p.aid, p.bet); msg += `😐 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 引き分け (返金)\n`; }
        else if (win) {
            let m = r.m > 0 ? r.m : 1; await addMoney(p.aid, p.bet + (p.bet * m));
            msg += `🎉 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 勝ち！ (+${fNum(p.bet * m)} コイン)\n`;
        } else msg += `💀 [piconname:${p.aid}]: [${r.d.join('')}] ${r.n} ➡ 負け...\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resolveChouhan = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let d1 = Math.floor(Math.random()*6)+1, d2 = Math.floor(Math.random()*6)+1, sum = d1+d2, res = (sum%2===0)?'chou':'han';
    let msg = `[info][title]🎲 丁半 結果発表[/title]出目: ${d1} と ${d2} (合計:${sum})\n➡ 『 ${res==='chou'?'丁(偶数)':'半(奇数)'} 』の勝ち！\n[hr][b]【 プレイヤー結果 】[/b]\n`;
    for (let p of g.players) {
        if (p.choice === res) { await addMoney(p.aid, p.bet * 2); msg += `🎉 [piconname:${p.aid}]: 的中！ (+${fNum(p.bet * 2)} コイン)\n`; }
        else msg += `💀 [piconname:${p.aid}]: 予想[${p.choice==='chou'?'丁':'半'}] ➡ はずれ...\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};

const resolveDerby = async (rid) => {
    let g = gSt[rid]; if (!g) return; clearTimeout(g.tid);
    let st = g.st, ws = [...st], tW = ws.reduce((a,b)=>a+b,0);
    let r1 = Math.random() * tW, s1 = 0, first = 1;
    for(let i=0; i<6; i++){ s1+=ws[i]; if(r1<=s1){ first=i+1; break; } }
    
    ws[first-1] = 0; tW = ws.reduce((a,b)=>a+b,0);
    let r2 = Math.random() * tW, s2 = 0, second = 1;
    for(let i=0; i<6; i++){ s2+=ws[i]; if(r2<=s2){ second=i+1; break; } }
    
    let winC = first < second ? `${first}-${second}` : `${second}-${first}`;
    let odd = g.oddsMap[winC];
    
    let msg = `[info][title]🐎 ダービー レース結果[/title]各馬一斉にスタート！\n...\n第4コーナーを回って最後の直線！\n...\n\n先頭で駆け抜けたのは【 ${first} 】番と【 ${second} 】番の馬だぁぁぁ！！！\n\n🎯 的中馬連: 【 ${winC} 】 (${odd}倍)\n[hr][b]【 プレイヤー結果 】[/b]\n`;
    for(let p of g.players){
        if(p.choice === winC){
            let winAmt = Math.floor(p.bet * odd); await addMoney(p.aid, p.bet + winAmt);
            msg += `🎉 [piconname:${p.aid}]: 的中！ (+${fNum(winAmt)} コイン)\n`;
        } else msg += `💀 [piconname:${p.aid}]: 予想[${p.choice}] ➡ はずれ...\n`;
    }
    await sendMsg(rid, msg + "[/info]"); gSt[rid] = null; await sb.from('config').upsert({ key: 'last_game_time', value: Date.now().toString() });
};
// ---- 後半ここから ----
app.post('/webhook', (req, res) => {
    if (!verify(req)) return res.status(401).send('Invalid');
    res.status(200).send('OK'); 
    const ev = req.body.webhook_event;
    if (!ev || req.body.webhook_event_type !== 'message_created') return;

    const rid = ev.room_id, body = ev.body || "", sId = ev.account_id.toString(), mId = ev.message_id;
    const today = getToday(), tMonth = getMonth();

    (async () => {
        try {
            // 返信タグの解析
            const rpM = body.match(/\[(?:rp|返信|qtmeta|reply)\s+aid=([0-9]+)/i);
            const rAid = rpM ? rpM[1] : null;

            // BL判定・パトロール
            const { data: isB } = await sb.from('blacklist').select('*').eq('account_id', sId).single();
            if (isB) { await kickTarget(rid, [sId], 'readonly'); await cw.delete(`/rooms/${rid}/messages/${mId}`).catch(()=>{}); return; }
            
            // スパム検知 (10連投)
            if (!spams[sId]) spams[sId]=[]; spams[sId].push(Date.now()); spams[sId]=spams[sId].filter(t=>Date.now()-t<=5000);
            if (spams[sId].length>=10 && !(await isAdmin(rid, sId))) {
                await kickTarget(rid, [sId], 'readonly');
                return sendTemp(rid, `[info][title]⚠️ 警告[/title][piconname:${sId}] 様\n連投行為を検知したため、発言権限を「閲覧のみ」に制限しました。[/info]`);
            }

            // 日替わりリセット・宝くじ抽選
            if (localLastReset !== today) {
                const { data: ld } = await sb.from('config').select('value').eq('key', 'last_reset_date').single();
                if (!ld || ld.value !== today) {
                    await sb.from('players').update({ slot_count: 0, work_limit: 5, work_date: null, skill_date: null }).neq('account_id', '0');
                    await sb.from('config').upsert({ key: 'last_reset_date', value: today });
                    localLastReset = today;
                    let m = `[info][title]🔄 日付更新のお知らせ[/title]深夜0時を回りました。\nスロット回数と仕事制限がリセットされました！\n[hr]`;
                    const { data: tData } = await sb.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = tData ? JSON.parse(tData.value) : [];
                    if (tks.length > 0) {
                        let win = Math.floor(Math.random() * 9999) + 1;
                        m += `[title]🎯 宝くじ 抽選結果発表[/title]本日の当選番号は...【 ${win} 】です！\n[hr]`;
                        let pays = {}; let wns = [];
                        const chP = (n, w) => {
                            if(n===w) return {p:30000, n:'🥇1等'};
                            let pr=w-1<1?9999:w-1, nx=w+1>9999?1:w+1;
                            if(n===pr||n===nx) return {p:15000, n:'🥈前後賞'};
                            if(n%1000===w%1000) return {p:10000, n:'🥈2等'}; 
                            if(n%100===w%100) return {p:5000, n:'🥉3等'};    
                            if(n%10===w%10) return {p:1000, n:'🏅4等'}; return null;
                        };
                        for (let t of tks) { let r = chP(t.num, win); if(r) { wns.push({aid:t.aid, num:t.num, ...r}); pays[t.aid]=(pays[t.aid]||0)+r.p; } }
                        if (wns.length > 0) {
                            for (let a in pays) await addMoney(a, pays[a]);
                            wns.sort((a,b)=>b.p-a.p); for (let w of wns.slice(0,20)) m += `[piconname:${w.aid}] 様: 予想[${w.num}] ➡ ${w.n} (+${fNum(w.p)} コイン)\n`;
                            if(wns.length>20) m += `...他 ${wns.length-20} 件の当選！\n`;
                        } else m += `本日の当選者はいませんでした。明日の挑戦をお待ちしています！\n`;
                        await sb.from('config').upsert({ key: 'lottery_tickets', value: '[]' });
                    }
                    sendMsg(rid, m + `[/info]`);
                }
            }

            // プレイヤーデータ取得
            const { data: p } = await sb.from('players').select('*').eq('account_id', sId).single();
            let myM = p?p.money:0, myD = p?(p.debt||0):0, myJ = p?(p.job||'サラリーマン'):'サラリーマン';
            let cDebt = (p && p.debt_month === tMonth) ? (p.monthly_debt||0) : 0;

            // ステルス仕事回復 (30〜50回発言で1回復)
            if (isGamble && !body.startsWith('/')) {
                let mc = (p ? p.msg_count || 0 : 0) + 1; let wl = p ? p.work_limit || 5 : 5;
                if (mc >= (Math.floor(Math.random()*21)+30)) { mc = 0; if (wl < 10) wl++; }
                if (p) await sb.from('players').update({ msg_count: mc, work_limit: wl }).eq('account_id', sId);
                else await sb.from('players').insert({ account_id: sId, money: 0, work_limit: 5, msg_count: 1 });
            }

            // --- ヘルプ ---
            if (body === '/help-gya') {
                const h = `[info][title]🎰 カジノ＆ライフ 総合案内 (V32)[/title]
[b]🏦 銀行・ステータス[/b]
・ /status : 自分の所持金・借金・職業などを確認
・ /give [金額] : 返信で相手に送金 (※10%のシステム税)
・ /debt [金額] : 借金する (1ヶ月の上限 5000コイン)
・ /money-rank : 純資産ランキング (5分で自動消滅)

[b]💼 職業・仕事[/b]
・ /job : 求人一覧と給与を確認
・ /job [職業名] : 指定の職業へ転職する
・ /work : 給料をもらう (10分に1回, 1日5回上限)
・ /catch または /goal : 特定職業の特殊能力 (1日1回)

[b]🎰 カジノ・宝くじ[/b]
・ /slot [掛金|max|half] : スロット (1日3回, 10分間隔)
・ /buy-lot [連番|バラ] [枚数] : 宝くじ購入 (1枚100コイン、深夜0時抽選)

[b]🎲 テーブルゲーム (3分間隔)[/b]
・ /chouhan : 丁半ゲーム募集
・ /cc : チンチロリン募集 (/roll でサイコロを振る)
・ /derby : みんなでダービー募集 (馬連にベット)

[b]👑 管理者専用[/b]
・ /take [金額] : 相手に特別資金を付与
・ /st-gya, /fi-gya : カジノ有効/無効化
・ /blacklist, /reblacklist : 追放・制限の管理
・ /remove-rank : ランキングから指定の人を除外[/info]`;
                return sendTemp(rid, h, 120000);
            }

            // --- 👑 管理者コマンド ---
            if (/(^|\n)\/take\b/.test(body) && isGamble && await isAdmin(rid, sId)) {
                let amt = parseInt((body.match(/(^|\n)\/take\s+([0-9]+)/) || [])[2] || (body.match(/(^|\n)\/take\s+[0-9]+\s+([0-9]+)/) || [])[3], 10);
                let target = rAid || (body.match(/(^|\n)\/take\s+([0-9]+)\s+[0-9]+/) || [])[2];
                if (target && amt > 0) { await addMoney(target, amt); return sendTemp(rid, `[info][title]👑 特別資金付与[/title]管理者が [piconname:${target}] 様へ ${fNum(amt)} コインを付与しました。[/info]`); }
            }

            if (/(^|\n)\/(blacklist|reblacklist|remove-rank)\b/.test(body)) {
                if (!(await isAdmin(rid, sId))) return;
                let target = rAid || (body.match(/(^|\n)\/(?:blacklist|reblacklist|remove-rank)\s+([0-9]+)/) || [])[2];
                let cmd = body.includes('/remove-rank') ? 'rank' : (body.includes('/reblacklist') ? 'remove' : 'add');
                if (!target && cmd !== 'add') return;
                if (!target && cmd === 'add') cmd = 'list';

                if (cmd === 'rank') {
                    const { data: exD } = await sb.from('config').select('value').eq('key', 'rank_excluded').single();
                    let ex = exD ? JSON.parse(exD.value) : [];
                    if (ex.includes(target)) { ex = ex.filter(i=>i!==target); sendTemp(rid, `[info][title]設定完了[/title][piconname:${target}] 様のランキング除外を解除しました。[/info]`); }
                    else { ex.push(target); sendTemp(rid, `[info][title]設定完了[/title][piconname:${target}] 様をランキングから除外しました。[/info]`); }
                    return await sb.from('config').upsert({ key: 'rank_excluded', value: JSON.stringify(ex) });
                }
                if (cmd === 'add') {
                    await sb.from('blacklist').insert({ account_id: target }); await kickTarget(rid, [target], 'readonly');
                    return sendTemp(rid, `[info][title]🚫 追放完了[/title][piconname:${target}] をブラックリストに登録し、権限を「閲覧のみ」に変更しました。[/info]`);
                } else if (cmd === 'remove') {
                    await sb.from('blacklist').delete().eq('account_id', target); return sendTemp(rid, `[info][title]✅ 解除完了[/title][piconname:${target}] の追放状態を解除しました。[/info]`);
                } else if (cmd === 'list') {
                    const { data } = await sb.from('blacklist').select('account_id');
                    const ls = data && data.length ? data.map(d => `[piconname:${d.account_id}]`).join('\n') : "登録なし";
                    return sendTemp(rid, `[info][title]📜 ブラックリスト一覧[/title]${ls}\n[hr]※このメッセージは1分後に自動消去されます[/info]`);
                }
            }

            if (body.startsWith('/st-gya') && await isAdmin(rid, sId)) { isGamble=true; await sb.from('config').upsert({ key:'gamble_active', value:'true' }); return sendMsg(rid, `[info][title]🎰 カジノ＆ライフ[/title]機能が【 有効 】になりました！[/info]`); }
            if (body.startsWith('/fi-gya') && await isAdmin(rid, sId)) { isGamble=false; await sb.from('config').upsert({ key:'gamble_active', value:'false' }); return sendMsg(rid, `[info][title]🚫 カジノ＆ライフ[/title]機能が【 停止 】しました。[/info]`); }

            // --- 🏦 銀行 (借金・送金・ステータス・ランキング) ---
            const dbM = body.match(/(^|\n)\/debt\s+([0-9]+)/);
            if (dbM && isGamble) {
                let amt = parseInt(dbM[2], 10);
                if (amt > 0) {
                    if (cDebt + amt > 5000) return sendTemp(rid, `[info][title]⚠️ 借金上限エラー[/title]${mkRp(sId, rid, mId)}\n1ヶ月の借金上限(5000コイン)を超えています！\n(今月は既に ${cDebt} コイン借りています)[/info]`);
                    if (p) await sb.from('players').update({ money: myM+amt, debt: myD+amt, monthly_debt: cDebt+amt, debt_month: tMonth }).eq('account_id', sId);
                    else await sb.from('players').insert({ account_id: sId, money: amt, debt: amt, monthly_debt: amt, debt_month: tMonth });
                    return sendTemp(rid, `[info][title]💳 お借り入れ完了[/title][piconname:${sId}] 様\n${fNum(amt)} コインの借金を行いました。\n[hr]今月の借金可能枠: 残り ${fNum(5000 - (cDebt + amt))} コイン\n※借金を含んだお金は他人に送金できません。[/info]`);
                }
            }

            if (/(^|\n)\/give/.test(body) && isGamble) {
                let target = rAid || (body.match(/(^|\n)\/give\s+([0-9]+)\s+([0-9]+)/) || [])[2];
                let amt = parseInt((body.match(/(^|\n)\/give\s+([0-9]+)$/) || [])[2] || (body.match(/(^|\n)\/give\s+[0-9]+\s+([0-9]+)/) || [])[3], 10);
                if (target && amt > 0) {
                    let avM = Math.max(0, myM - myD);
                    if (avM < amt) return sendTemp(rid, `[info][title]⚠️ 送金エラー[/title]${mkRp(sId, rid, mId)}\n送金枠が不足しています！\n(借金があるため、送れる純資産は ${fNum(avM)} コインのみです)[/info]`);
                    let tax = Math.floor(amt * 0.10); let rAmt = amt - tax;
                    await sb.from('players').update({ money: myM - amt }).eq('account_id', sId);
                    const { data: rec } = await sb.from('players').select('*').eq('account_id', target).single();
                    if (rec) await sb.from('players').update({ money: rec.money + rAmt }).eq('account_id', target);
                    else await sb.from('players').insert({ account_id: target, money: rAmt, debt: 0 });
                    return sendTemp(rid, `[info][title]🎁 送金完了[/title][piconname:${sId}] ➡ [piconname:${target}]\n${fNum(amt)} コインを送金しました。\n[hr]※システム税(-${fNum(tax)} コイン)が引かれ、相手には ${fNum(rAmt)} コインが届きました。[/info]`);
                }
            }

            if (body === '/status') return sendTemp(rid, `[info][title]📊 プレイヤー情報[/title][piconname:${sId}] 様\n\n💰 所持金: ${fNum(myM)} コイン\n💳 借金: -${fNum(myD)} コイン\n💎 純資産: ${fNum(myM - myD)} コイン\n[hr]👔 職業: ${myJ}\n🎰 スロット残り: ${Math.max(0,3-(p?p.slot_count:0))} 回\n💼 お仕事残り: ${p?p.work_limit:0} 回\n\n※このメッセージは1分後に自動消去されます[/info]`);
            
            if (body === '/money-rank') {
                const { data: exD } = await sb.from('config').select('value').eq('key', 'rank_excluded').single();
                let ex = exD ? JSON.parse(exD.value) : [];
                const { data: list } = await sb.from('players').select('*');
                let f = list ? list.filter(d => !ex.includes(d.account_id)) : [];
                f.sort((a,b)=>((b.money||0)-(b.debt||0))-((a.money||0)-(a.debt||0)));
                const s = f.slice(0,10).map((d,i)=>{
                    let net = (d.money||0)-(d.debt||0); let md = i===0?"🥇":(i===1?"🥈":(i===2?"🥉":"🔹"));
                    return `${md} ${i+1}位: [piconname:${d.account_id}]\n　💰 純資産: ${fNum(net)} コイン ${d.debt>0?`(所持:${fNum(d.money)} 借金:-${fNum(d.debt)})`:''} [${d.job||'サラリーマン'}]`;
                }).join('\n[hr]');
                return sendTemp(rid, `[info][title]👑 純資産ランキング TOP10[/title]${s}\n[hr]※このメッセージは5分後に自動消去されます[/info]`, 300000);
            }

            // --- 💼 職業 ---
            if (body === '/job' && isGamble) {
                return sendTemp(rid, `[info][title]💼 ハローワーク (求人一覧)[/title]
👨‍💼 [b]サラリーマン[/b] (就職費用: 0)
 ▶ /work (100〜500) ※10%でミスして0コイン

🏛️ [b]公務員[/b] (就職費用: 2000)
 ▶ /work (300〜500)

🚓 [b]警察官[/b] (就職費用: 3000)
 ▶ /work (300〜700)
 ▶ /catch (30%の確率で犯人逮捕! 800)

⚽ [b]プロスポーツ選手[/b] (就職費用: 5000)
 ▶ /work (500〜1000)
 ▶ /goal (30%の確率でゴール! 1000)
[hr]※転職コマンド: /job 役職名[/info]`);
            }

            const jMatch = body.match(/^\/job\s+(サラリーマン|公務員|警察官|プロスポーツ選手)/);
            if (jMatch && isGamble) {
                const jn = jMatch[1]; const cs = {'サラリーマン': 0, '公務員': 2000, '警察官': 3000, 'プロスポーツ選手': 5000};
                if (myJ === jn) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\nすでに ${jn} に就いています！[/info]`);
                if (myM < cs[jn]) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\nお金が足りません！(転職費用: ${fNum(cs[jn])} コイン)[/info]`);
                if (p) await sb.from('players').update({ job: jn, money: myM - cs[jn] }).eq('account_id', sId);
                else await sb.from('players').insert({ account_id: sId, job: jn, money: -cs[jn] });
                return sendTemp(rid, `[info][title]🎉 転職おめでとうございます！[/title][piconname:${sId}] 様\n本日より「${jn}」としてご活躍ください！ (-${fNum(cs[jn])} コイン)[/info]`);
            }

            if (body === '/work' && isGamble && p) {
                if (p.work_limit <= 0) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日の仕事回数が上限(5回)に達しました。[/info]`);
                if (Date.now() - (p.last_work_time || 0) < 1000) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n休憩中です！仕事は10分間隔で行えます。[/info]`);
                let earn = 0; let msg = "";
                if (myJ === 'サラリーマン') { if (Math.random() < 0.1) { earn=0; msg="仕事で大きなミスをしてしまい、本日の給料は 0 コインになりました...😭"; } else { earn=Math.floor(Math.random()*401)+100; msg=`真面目に働き、 ${fNum(earn)} コイン稼ぎました！💼`; } }
                else if (myJ === '公務員') { earn=Math.floor(Math.random()*201)+300; msg=`安定した仕事をこなし、 ${fNum(earn)} コイン稼ぎました！🏛️`; }
                else if (myJ === '警察官') { earn=Math.floor(Math.random()*401)+300; msg=`街の平和を守り、 ${fNum(earn)} コイン稼ぎました！🚓`; }
                else if (myJ === 'プロスポーツ選手') { earn=Math.floor(Math.random()*501)+500; msg=`試合で大活躍し、 ${fNum(earn)} コイン稼ぎました！⚽`; }
                await sb.from('players').update({ last_work_time: Date.now(), work_limit: p.work_limit - 1 }).eq('account_id', sId);
                await addMoney(sId, earn); return sendTemp(rid, `[info][title]💼 お仕事完了[/title][piconname:${sId}]\n${msg}\n(残り ${p.work_limit - 1} 回)[/info]`);
            }

            if ((body === '/catch' || body === '/goal') && isGamble && p) {
                let isC = body === '/catch';
                if (isC && myJ !== '警察官') return sendTemp(rid, `[info]⚠️ 警察官専用のコマンドです！[/info]`);
                if (!isC && myJ !== 'プロスポーツ選手') return sendTemp(rid, `[info]⚠️ プロスポーツ選手専用のコマンドです！[/info]`);
                if (p.skill_date === today) return sendTemp(rid, `[info]⚠️ 今日の特殊能力はすでに使用済みです！[/info]`);
                let succ = Math.random() < 0.3; let earn = 0; let msg = "";
                if (isC) { if (succ) { earn=800; msg=`見事犯人を逮捕しました！特別報酬 ${earn} コイン獲得！🚨`; } else msg=`犯人を逃してしまいました...🏃‍♂️💨`; }
                else { if (succ) { earn=1000; msg=`スーパーゴールを決めました！スポンサーから ${earn} コイン獲得！🥅✨`; } else msg=`シュートは外れてしまいました...🤦‍♂️`; }
                await sb.from('players').update({ skill_date: today }).eq('account_id', sId);
                await addMoney(sId, earn); return sendTemp(rid, `[info][title]✨ 特殊能力発動[/title][piconname:${sId}]\n${msg}[/info]`);
            }

            // --- 🎰 スロット / 宝くじ ---
            const sM = body.match(/(^|\n)\/slot\s+(max|half|[0-9]+)/);
            if (sM && isGamble && p) {
                if (p.slot_count >= 15) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\n本日のスロットは上限(1日15回)に達しました！[/info]`);
                if (Date.now() - (p.last_slot_time || 0) < 4000000) return sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)}\nクールタイム…！[/info]`);
                let bet = sM[2] === 'max' ? myM : (sM[2] === 'half' ? Math.floor(myM/2) : parseInt(sM[2], 10));
                if (bet > 0 && myM >= bet) {
                    await sb.from('players').update({ money: myM - bet, last_slot_time: Date.now(), slot_count: p.slot_count + 1 }).eq('account_id', sId);
                    const r = Math.random() * 1000; let ml = 0, sym = "", res = "";
                    if (r < 5) { ml=100; sym="🐉 | 🐉 | 🐉"; res="🔥 超大当たり！！！ (100倍)"; } 
                    else if (r < 20) { ml=10; sym="7️⃣ | 7️⃣ | 7️⃣"; res="✨ 大当たり！ (10倍)"; } 
                    else if (r < 100) { ml=3; let s=["6️⃣","5️⃣","4️⃣"][Math.floor(Math.random()*3)]; sym=`${s} | ${s} | ${s}`; res="🎉 当たり！ (3倍)"; } 
                    else if (r < 200) { ml=2; let s=["3️⃣","2️⃣","1️⃣"][Math.floor(Math.random()*3)]; sym=`${s} | ${s} | ${s}`; res="🎉 当たり！ (2倍)"; } 
                    else if (r < 300) { ml=2; let s=["🍉","🍋","🔔","🍇"][Math.floor(Math.random()*4)]; sym=`${s} | ${s} | ${s}`; res="🍇 フルーツ揃い！ (2倍)"; } 
                    else if (r < 400) { ml=1; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let s1=o[Math.floor(Math.random()*o.length)], s2=o[Math.floor(Math.random()*o.length)]; let a=["🍒",s1,s2].sort(()=>Math.random()-0.5); sym=a.join(" | "); res="🍒 チェリー出現！ (1倍)"; } 
                    else { ml=0; let o=["🍉","🍋","🔔","🍇","7️⃣","6️⃣","5️⃣"]; let r1=o[Math.floor(Math.random()*o.length)], r2=o[Math.floor(Math.random()*o.length)], r3=o[Math.floor(Math.random()*o.length)]; while(r1===r2&&r2===r3) r3=o[Math.floor(Math.random()*o.length)]; sym=`${r1} | ${r2} | ${r3}`; res="💀 はずれ..."; }
                    let wA = bet * ml; if (wA > 0) await addMoney(sId, wA);
                    return sendMsg(rid, `[info][title]🎰 SLOT MACHINE[/title]${mkRp(sId, rid, mId)}\n[hr]　▶ [ ${sym} ] ◀　\n[hr]${res}\n\n賭け金: ${fNum(bet)} ➡ 獲得: ${fNum(wA)} コイン\n(残り回数: ${15 - (p.slot_count+1)}回)[/info]`);
                } else return sendTemp(rid, `[info]⚠️ お金が足りません！[/info]`);
            }

            const lM = body.match(/(^|\n)\/buy-lot\s+(連番|バラ)\s+([0-9]+)/);
            if (lM && isGamble) {
                let md = lM[2], cnt = parseInt(lM[3], 10);
                if (cnt > 0 && cnt <= 100) {
                    let cost = cnt * 100; if (myM < cost) return sendTemp(rid, `[info]⚠️ お金が足りません！ (${cnt}枚 = ${fNum(cost)}コイン)[/info]`);
                    const { data: lD } = await sb.from('config').select('value').eq('key', 'lottery_tickets').single();
                    let tks = lD ? JSON.parse(lD.value) : []; let uN = new Set(tks.map(t=>t.num)); let mN = [];
                    if (md === '連番') {
                        let st = -1, rs = Math.floor(Math.random()*(100000-cnt))+1;
                        for(let i=0;i<10000;i++){ let s=((rs+i)%(100000-cnt))+1; let ok=true; for(let j=0;j<cnt;j++){ if(uN.has(s+j)){ ok=false; break; } } if(ok){ st=s; break; } }
                        if(st===-1) return sendTemp(rid, `[info]⚠️ 連続した空き番号がありません。[/info]`);
                        for(let j=0;j<cnt;j++) mN.push(st+j);
                    } else {
                        let av = []; for(let i=1;i<=99999;i++) if(!uN.has(i)) av.push(i);
                        if(av.length<cnt) return sendTemp(rid, `[info]⚠️ 残りのくじが足りません。[/info]`);
                        for(let i=av.length-1;i>0;i--){ const r=Math.floor(Math.random()*(i+1)); [av[i],av[r]]=[av[r],av[i]]; }
                        mN = av.slice(0, cnt);
                    }
                    await sb.from('players').update({ money: myM - cost }).eq('account_id', sId);
                    for (let n of mN) tks.push({ aid: sId, num: n });
                    await sb.from('config').upsert({ key: 'lottery_tickets', value: JSON.stringify(tks) });
                    let ns = mN.length > 5 ? mN.slice(0,5).join(', ') + ` ...他${cnt-5}枚` : mN.join(', ');
                    return sendTemp(rid, `[info][title]🎟 宝くじ購入完了[/title][piconname:${sId}] 様\n宝くじを ${cnt} 枚（${md}）購入しました！\n番号: ${ns}\n\n(※抽選は深夜0時に行われます)[/info]`);
                }
            }

            // --- 🎲 ゲーム共通・進行 ---
            const { data: lg } = await sb.from('config').select('value').eq('key', 'last_game_time').single();
            const gCD = (Date.now() - parseInt(lg ? lg.value : 0)) < 1000; // 3分間隔

            if (body.match(/(^|\n)\/(chouhan|cc|derby)\b/) && isGamble) {
                if (gSt[rid]) return sendTemp(rid, `[info]⚠️ 他のゲームが進行中です。[/info]`);
                if (gCD) return sendTemp(rid, `[info]⚠️ エラーが発生しました。もう一度お試しください。[/info]`);
                
                let t = body.includes('/derby') ? 'db' : (body.includes('/cc') ? 'cc' : 'ch');
                gSt[rid] = { type: t, state: 'RECRUITING', host: sId, players: [{ aid: sId, bet: 0 }], oddsMap: {}, oddsStr: "", st: [] };
                
                let title = t==='db'?"🐎 ダービー":(t==='cc'?"🎲 チンチロリン":"🎲 丁半ゲーム");
                let ex = t==='db'?"/join derby":(t==='cc'?"/join cc":"/join chouhan");
                
                if (t === 'db') { let dO = genDerby(); gSt[rid].oddsMap = dO.oddsMap; gSt[rid].oddsStr = dO.oddsStr; gSt[rid].st = dO.st; }
                
                sendTemp(rid, `[info][title]${title} 募集開始[/title]ホスト:[piconname:${sId}]\n参加者は ${ex} と入力！(現在 1人)\n※1分経過で自動進行します。[/info]`);
                startTimer(rid); return;
            }

            if (body.match(/(^|\n)\/join\s+(chouhan|cc|derby)/) && isGamble && gSt[rid]?.state === 'RECRUITING') {
                if (!gSt[rid].players.find(x=>x.aid===sId)) { gSt[rid].players.push({ aid: sId, bet: 0 }); sendMsg(rid, `[info]🎲 [piconname:${sId}] が参加しました！ (現在 ${gSt[rid].players.length}人)[/info]`); }
                return;
            }

            if (body.match(/(^|\n)\/start(chouhan|cc|derby)/) && isGamble && gSt[rid]?.state === 'RECRUITING' && gSt[rid].host === sId) {
                if (gSt[rid].players.length < 2) return sendTemp(rid, `[info]⚠️ 参加者が2人以上でないと開始できません。[/info]`);
                clearTimeout(gSt[rid].tid); handleTO(rid); return;
            }

            if (body === '/leave' && isGamble && gSt[rid]) {
                let idx = gSt[rid].players.findIndex(p => p.aid === sId);
                if (idx !== -1) {
                    let p = gSt[rid].players[idx]; gSt[rid].players.splice(idx, 1);
                    if (p.bet > 0) await addMoney(sId, p.bet);
                    sendTemp(rid, `[info][piconname:${sId}] 退出しました[/info]`);
                    if (gSt[rid].players.length === 0) { clearTimeout(gSt[rid].tid); gSt[rid] = null; return sendTemp(rid, `[info]参加者がいなくなりゲームを中止しました。[/info]`); }
                    chkProg(rid);
                }
                return;
            }

            const bM = body.match(/(^|\n)\/bet\s+(max|half|[0-9]+)(?:\s+([0-9]+-[0-9]+))?/);
            if (bM && isGamble && gSt[rid]?.state === 'BETTING') {
                let p = gSt[rid].players.find(x=>x.aid===sId);
                if (p && p.bet === 0) {
                    let b = bM[2] === 'max' ? myM : (bM[2] === 'half' ? Math.floor(myM/2) : parseInt(bM[2], 10));
                    if (b > 0 && myM >= b) {
                        if (gSt[rid].type === 'db') {
                            let h = bM[3];
                            if (!h || !gSt[rid].oddsMap[h]) return sendTemp(rid, `[info]⚠️ 馬連(例: 1-2)を正しく指定してください\n例: /bet 100 1-2[/info]`);
                            p.choice = h;
                        }
                        p.bet = b; await sb.from('players').update({ money: myM - b }).eq('account_id', sId);
                        sendTemp(rid, `[info][piconname:${sId}] ${fNum(b)} コインをベットしました！[/info]`);
                        chkProg(rid);
                    } else sendTemp(rid, `[info]⚠️ ${mkRp(sId, rid, mId)} お金が足りません！[/info]`);
                }
                return;
            }

            if ((body === '/chou' || body === '/han') && isGamble && gSt[rid]?.type === 'ch' && gSt[rid].state === 'ACTION') {
                let p = gSt[rid].players.find(x=>x.aid===sId);
                if (p && !p.choice) { p.choice = body.slice(1); sendTemp(rid, `[info][piconname:${sId}] 「${p.choice==='chou'?'丁':'半'}」を選択しました！[/info]`); chkProg(rid); }
            }

            if (body === '/roll' && isGamble && gSt[rid]?.type === 'cc' && gSt[rid].state === 'ACTION') {
                let p = gSt[rid].players.find(x=>x.aid===sId);
                if (p && !p.res && sId !== gSt[rid].host) {
                    p.res = getRoll(); sendMsg(rid, `[info]🎲 [piconname:${sId}] の出目: ${p.res.n} [ ${p.res.d.join(',')} ][/info]`); chkProg(rid);
                }
            }

        } catch (e) { console.error(e); }
    })();
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Run ${PORT}`));

module.exports = app;
