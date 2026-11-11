/* =====================================================================
   项目管理 + 云端配音接入（网页增强层）

   1. 左侧「项目管理」：新建 / 切换 / 删除项目，每个项目单独保存
      视频文案、封面标题、配音音色、语速、更多设置里的全部字段。
      数据存在本机 localStorage，按登录账号隔离，不上传、不进项目包。
   2. 右侧「配音音色」：把服务端已跑通的火山豆包 2.0 云端音色填进下拉，
      并给「效果试听」接上 /api/cloud/preview。

   本文件不改 index.html 的原生业务逻辑，只补控件与事件。
   ===================================================================== */
(() => {
  const el = id => document.getElementById(id);
  const TEXT_IDS = ["script", "title", "voicePick", "speed", "refLink", "pathRun",
                    "srcDir", "bgmPick", "voPick", "refCover"];
  const CHECK_IDS = ["fxSub", "fxSfx", "fxRefBgm", "coverAuto", "coverCustom"];

  /* 新建项目 = 一条全新的空白工作流。下面这些是「清零」后的默认值，
     不再沿用上一个项目选过的音色 / 语速 / BGM 链接 / 成片路径。 */
  const TEXT_DEFAULTS = {
    script: "", title: "", voicePick: "", speed: "100",
    refLink: "", pathRun: "", srcDir: "", bgmPick: "", voPick: "", refCover: ""
  };
  const CHECK_DEFAULTS = {
    fxSub: true, fxSfx: true, fxRefBgm: true, coverAuto: true, coverCustom: false
  };
  const defaultVoice = () => (CLOUD?.ready && CLOUD.defaultVoice)
    ? "cloud:" + CLOUD.defaultVoice
    : "zh-CN-YunjianNeural";

  let store = null;
  let storeKey = "";
  let initedFor = "";
  let saveTimer = 0;
  let CLOUD = null;

  /* ---------------- 云端音色 ---------------- */
  async function loadCloudVoices(){
    const group = el("cloudVoiceGroup");
    if (!group) return;
    try {
      const r = await api("/api/cloud/voices");
      CLOUD = r;
      const list = r.voices || [];
      group.innerHTML = list.map(v =>
        `<option value="cloud:${esc(v.id)}">${esc(v.name)}</option>`).join("");
      if (!list.length){
        const o = document.createElement("option");
        o.disabled = true;
        o.textContent = "（云端音色不可用）";
        group.appendChild(o);
      }
      // 页面初始时云端 optgroup 是空的，浏览器已经默认选中了系统音色那一组的
      // 第一个 <option value="">。动态补上 option 不会自动改选中项，必须显式切过去，
      // 否则「接入到网页」等于没默认生效。（项目里保存过的选择由 projects.apply 覆盖）
      const pick = el("voicePick");
      if (pick && r.ready && list.length && !pick.value.startsWith("cloud:")){
        pick.value = "cloud:" + (r.defaultVoice || list[0].id);
      }
      const hint = el("voicePickHint"), st = el("voiceState");
      if (hint){
        hint.classList.toggle("warn", !r.ready);
        hint.textContent = r.ready
          ? (r.provider === "volc"
              ? "云端音色：联网合成，不用装本机权重；每句约 1–2 秒，按量计费。"
              : "免费音色：随包 edge-tts，不配 key 也能用。")
          : "云端配音暂不可用：" + (r.missing || []).join("；") + "，可先用系统音色。";
      }
      if (st){
        st.className = "voice-state " + (r.ready ? "ok" : "warn");
        st.textContent = r.ready
          ? (r.provider === "volc" ? "● 云端配音已就绪 · 火山豆包 2.0" : "● 免费音色已就绪")
          : "● 云端配音未配置";
        if (r.locked) st.textContent += " · 已绑定原片复刻音色";
      }
    } catch(e){
      const hint = el("voicePickHint");
      if (hint){ hint.textContent = "云端音色检测失败：" + e.message; hint.classList.add("warn"); }
    }
  }

  /* ---------------- 效果试听 ---------------- */
  const tryBtn = el("btnVoiceTry");
  if (tryBtn){
    tryBtn.addEventListener("click", async () => {
      const vp = el("voicePick")?.value || "";
      const voice = vp.startsWith("cloud:") ? vp.slice(6) : (vp || "zh-CN-YunjianNeural");

      const first = (typeof scriptLines === "function" ? scriptLines()[0] : "") || "选矿选不好，一年白干。";
      const st = el("tryState");
      tryBtn.disabled = true;
      tryBtn.textContent = "合成中…";
      if (st) st.textContent = "正在用当前音色和语速合成第一句…";
      try {
        const r = await postJson("/api/cloud/preview", {
          text: first, voice, speed: +((el("speed")?.value || 100) / 100).toFixed(2)
        });
        const a = el("cloudPreviewAudio");
        a.src = r.url + "&t=" + Date.now();
        await a.play();
        if (st) st.textContent = r.cached ? "已缓存 · 正在播放" : "已合成 · 正在播放";
        tryBtn.textContent = "▶ 再听一次";
      } catch(e){
        if (st) st.textContent = "试听失败：" + e.message;
        toast(e.message || "试听失败");
        tryBtn.textContent = "▶ 效果试听";
      } finally {
        tryBtn.disabled = false;
      }
    });
  }

  /* ---------------- 项目存取 ---------------- */
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const stamp = () => new Date().toLocaleString("zh-CN",
    { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  function readStore(key){
    try {
      const s = JSON.parse(localStorage.getItem(key) || "null");
      if (s && Array.isArray(s.list)) return { list: s.list, activeId: s.activeId || "", data: s.data || {} };
    } catch(e){}
    return { list: [], activeId: "", data: {} };
  }
  function writeStore(){
    if (!store || !storeKey) return;
    try { localStorage.setItem(storeKey, JSON.stringify(store)); } catch(e){}
  }

  function capture(){
    const d = {};
    for (const id of TEXT_IDS){ const x = el(id); if (x) d[id] = x.value ?? ""; }
    for (const id of CHECK_IDS){ const x = el(id); if (x) d[id] = !!x.checked; }
    d.refVideo = (typeof S !== "undefined" && S.refVideo) || "";
    d.moreOpen = !!el("moreSettings")?.open;
    // 素材墙、预览、成片结果也按项目隔离：切回来能恢复，新建的空项目则全部清掉
    d.mats = (typeof S !== "undefined" ? (S.mats || []) : []).map(m => ({
      path: m.path, name: m.name, kind: m.kind, size: m.size, sel: !!m.sel, up: !!m.up
    }));
    try { d.job = S.job ? JSON.parse(JSON.stringify(S.job)) : null; } catch(e){ d.job = null; }
    d.generated = !!(typeof S !== "undefined" && S.generated);
    return d;
  }

  function apply(d){
    if (!d) return;
    for (const id of TEXT_IDS){
      const x = el(id);
      if (!x || d[id] === undefined) continue;
      let v = d[id];
      // 旧版本项目里存的是空值（系统音色默认项），升级后让它默认走云端。
      // 现在云健有显式 value，用户主动选它不会被这里改掉。
      if (id === "voicePick" && !v && CLOUD?.ready && CLOUD.defaultVoice
          && el("cloudVoiceGroup")?.children.length) v = "cloud:" + CLOUD.defaultVoice;
      x.value = v;
      // 旧项目里可能存过已经下线的克隆音色 / 不存在的 option，别让下拉落回空值
      if (id === "voicePick" && x.value !== v && CLOUD?.ready && CLOUD.defaultVoice)
        x.value = "cloud:" + CLOUD.defaultVoice;
    }
    for (const id of CHECK_IDS){ const x = el(id); if (x && d[id] !== undefined) x.checked = !!d[id]; }
    if (typeof saveFx === "function") saveFx();   // 刷新页面后特效开关也跟项目一致
    const more = el("moreSettings");
    if (more) more.open = !!d.moreOpen;
    const drop = el("coverDrop");
    if (drop) drop.hidden = !el("coverCustom")?.checked;

    // 这些是 index.html 原生逻辑维护的 localStorage，项目切换要一起同步。
    // 空值直接删键，别把上一个项目的路径以空字符串形式带回来。
    const syncLS = (k, v) => {
      try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch(e){}
    };
    syncLS("pick_vo", d.voPick);
    syncLS("pick_bgm", d.bgmPick);
    syncLS("remix.outDir", d.pathRun);
    syncLS("remix.srcDir", d.srcDir);
    syncLS("remix.refVideo", d.refVideo ? JSON.stringify({ path: d.refVideo, name: "参考视频" }) : "");
    if (typeof showRef === "function") showRef(d.refVideo ? { path: d.refVideo, name: "参考视频" } : null);
    if (typeof S !== "undefined") S.refVideo = d.refVideo || "";

    // 素材墙 + 预览 + 成片结果：有就恢复，没有就清回初始态（新建项目走这条）
    if (typeof S !== "undefined"){
      S.mats = (d.mats || []).map(m => ({ ...m }));
      if (typeof renderMats === "function") renderMats();
    }
    if (d.job && d.generated && typeof onDone === "function") onDone(d.job, true, true);
    else if (typeof resetResult === "function") resetResult();

    if (typeof syncFoot === "function") syncFoot();
    if (typeof markFx === "function") markFx();
    // loadAudios 在页面初次加载时还没登录，下拉是空的；登录/切项目后补一次，
    // 它会按上面同步好的 pick_vo / pick_bgm 把选项选回来
    if (typeof loadAudios === "function") loadAudios();
  }

  function saveCurrent(){
    if (!store || !store.activeId) return;
    store.data[store.activeId] = capture();
    writeStore();
  }
  function queueSave(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrent, 450);
  }

  function renderProjects(){
    const box = el("projList");
    if (!box) return;
    el("projCount").textContent = String(store.list.length);
    box.innerHTML = store.list.length ? store.list.map(p => `
      <div class="proj-item ${p.id === store.activeId ? "on" : ""}">
        <button class="proj-open" data-id="${esc(p.id)}" title="切换到「${esc(p.name)}」">
          <b>${esc(p.name)}</b><small>${esc(p.at || "")}</small>
        </button>
        <button class="proj-del" data-id="${esc(p.id)}" title="删除项目" aria-label="删除项目 ${esc(p.name)}">×</button>
      </div>`).join("") : `<div class="proj-empty">还没有项目，点上面「新建项目」开一个。</div>`;
    const cur = store.list.find(p => p.id === store.activeId);
    const tag = el("curProjName");
    if (tag) tag.textContent = cur ? cur.name : "—";
  }

  function blankFrom(){
    // 新建项目 = 全新的空白工作流：文案、标题、音色、语速、BGM 链接、成片路径、
    // 封面、素材选择、预览与成片结果全部回默认，不继承上一个项目。
    return {
      ...TEXT_DEFAULTS, ...CHECK_DEFAULTS,
      voicePick: defaultVoice(),
      refVideo: "", moreOpen: !!el("moreSettings")?.open,
      mats: [], job: null, generated: false
    };
  }

  function switchTo(id){
    if (!store.data[id] || id === store.activeId) return;
    saveCurrent();
    store.activeId = id;
    writeStore();
    apply(store.data[id]);
    renderProjects();
  }

  function createProject(name){
    saveCurrent();
    const p = { id: newId(), name: name || ("项目 " + (store.list.length + 1)), at: stamp() };
    store.list.push(p);
    store.data[p.id] = blankFrom();
    store.activeId = p.id;
    writeStore();
    apply(store.data[p.id]);
    // 这些不属于表单值，得单独清：上传的封面、音频试听、云端试听、素材提示
    if (typeof clearCover === "function") clearCover();
    if (typeof clearAudioPreview === "function") clearAudioPreview();
    const a = el("cloudPreviewAudio");
    if (a){ a.pause(); a.removeAttribute("src"); a.load(); }
    const ts = el("tryState");
    if (ts) ts.textContent = "用当前音色和语速念第一句文案";
    const tb = el("btnVoiceTry");
    if (tb) tb.textContent = "▶ 效果试听";
    if (typeof hint === "function") hint("填本机文件夹路径，直接读，不用上传", true);
    renderProjects();
    const inp = el("projName");
    if (inp) inp.value = "";
    toast("已新建「" + p.name + "」· 内容已清空");
  }

  function removeProject(id){
    const p = store.list.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`确定删除项目「${p.name}」？该项目里保存的文案和设置会一起删掉，不可恢复。`)) return;
    store.list = store.list.filter(x => x.id !== id);
    delete store.data[id];
    if (store.activeId === id){
      store.activeId = store.list[0]?.id || "";
      if (!store.activeId){
        const np = { id: newId(), name: "默认项目", at: stamp() };
        store.list.push(np); store.activeId = np.id; store.data[np.id] = blankFrom();
      }
      apply(store.data[store.activeId]);
    }
    writeStore();
    renderProjects();
  }

  function bindProjectUI(){
    const newBtn = el("btnNewProj"), nameInput = el("projName"), list = el("projList");
    if (newBtn) newBtn.addEventListener("click", () => createProject((nameInput?.value || "").trim()));
    if (nameInput) nameInput.addEventListener("keydown", e => {
      if (e.key === "Enter"){ e.preventDefault(); createProject(nameInput.value.trim()); }
    });
    if (list) list.addEventListener("click", e => {
      const del = e.target.closest(".proj-del");
      if (del){ removeProject(del.dataset.id); return; }
      const open = e.target.closest(".proj-open");
      if (open) switchTo(open.dataset.id);
    });

    const ids = [...TEXT_IDS, ...CHECK_IDS];
    for (const id of ids){
      const x = el(id);
      if (!x) continue;
      const evt = (x.tagName === "SELECT" || x.type === "checkbox" || x.type === "radio") ? "change" : "input";
      x.addEventListener(evt, queueSave);
    }
    el("moreSettings")?.addEventListener("toggle", queueSave);
    // 参考视频抓取是异步的，抓完补存一次，保证项目里记的是这条链接对应的文件
    el("btnFetchRef")?.addEventListener("click", () => setTimeout(saveCurrent, 3500));
    window.addEventListener("beforeunload", saveCurrent);
  }

  /* ---------------- 登录后初始化 ---------------- */
  function initProjects(uid){
    const who = String(uid || 0);
    storeKey = "remix.projects.u" + who;
    store = readStore(storeKey);
    if (!store.list.length){
      const p = { id: newId(), name: "默认项目", at: stamp() };
      store.list = [p];
      store.activeId = p.id;
      store.data[p.id] = capture();   // 老版本留在页面上的内容不丢
    }
    if (!store.list.some(p => p.id === store.activeId)) store.activeId = store.list[0].id;
    if (!store.data[store.activeId]) store.data[store.activeId] = capture();
    renderProjects();
    apply(store.data[store.activeId]);
    if (initedFor !== who){ bindProjectUI(); initedFor = who; }
  }

  const prev = typeof afterLogin === "function" ? afterLogin : null;
  if (prev){
    afterLogin = async function(){
      const owner = typeof ME !== "undefined" ? ME?.id : null;
      await prev();
      if (typeof ME !== "undefined" && ME && ME.id !== owner && owner) return;
      await loadCloudVoices();
      initProjects(typeof ME !== "undefined" ? ME?.id : null);
    };
  }
})();
