/* ===================== 前端增强（本地渲染版） =====================
   网页配音只剩两条通道：
     云端音色  → server/cloudvoice.mjs（火山豆包 2.0 / edge），网页新接入
     系统音色  → 随包 edge-tts（server/tts.mjs）
   本机 F5 / GPT-SoVITS 克隆音色的入口已按用户要求从网页移除：
   下拉里不再有「我的克隆音色」这一组，也不再请求 /api/clone/voices。
   （服务端那条能力保留给 MCP / 命令行用，只是网页不再暴露。）

   云端音色清单、效果试听、项目管理都在 assets/projects.js。
   这里只剩一件事：封面图上传到服务器，拿到本机路径填给 refCover。 */
(() => {
  const el = id => document.getElementById(id);

  /* ---------- 封面上传 ---------- */
  pickCover = async function(file){
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 10 * 1048576)
      return toast("请选择 10MB 以内的封面图片");
    try {
      const r = await fetch("/api/upload?name=" + encodeURIComponent(file.name),
        { method: "POST", body: file, credentials: "same-origin" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "封面保存失败");
      const saved = j.saved?.[0] || j.files?.[0];
      if (!saved?.path) throw new Error("未收到封面文件路径");
      clearCover();
      el("coverCustom").checked = true;
      el("coverDrop").hidden = false;
      el("refCover").value = saved.path;
      el("coverImg").src = "/api/media?path=" + encodeURIComponent(saved.path);
      el("coverName").textContent = file.name;
      el("coverMeta").textContent = (file.size / 1048576).toFixed(1) + " MB";
      el("coverEmpty").hidden = true;
      el("coverPrev").hidden = false;
      toast("封面已保存");
    } catch(e){
      toast(e.message);
    }
  };
})();
