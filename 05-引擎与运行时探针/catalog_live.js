// Fetch the LIVE model catalog the client actually uses and inspect the opencode provider's endpoint.
(async () => {
  for (const url of ['https://models.opencode.ai', 'https://models.opencode.ai/api.json', 'https://opencode.ai/api/config']) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'opencode/1.19.2' } });
      const t = await r.text();
      console.log(`\n### ${url} -> ${r.status} (${t.length} bytes)`);
      if (r.status !== 200) { console.log('   ' + t.slice(0, 200)); continue; }
      let j = null; try { j = JSON.parse(t); } catch { console.log('   (not JSON) ' + t.slice(0, 200)); continue; }
      const prov = j.provider || j.providers || j;
      for (const key of ['opencode', 'opencode-go']) {
        const p = prov[key];
        if (!p) { console.log(`   provider ${key}: ABSENT`); continue; }
        console.log(`   provider ${key}: api=${JSON.stringify(p.api)} env=${JSON.stringify(p.env)} npm=${p.npm} models=${p.models ? Object.keys(p.models).length : 'n/a'}`);
      }
      const keys = Object.keys(j).slice(0, 12);
      console.log('   top-level keys: ' + keys.join(', '));
    } catch (e) { console.log(`\n### ${url} -> ERR ${e.message}`); }
  }
})();
