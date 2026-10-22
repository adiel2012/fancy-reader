(function () {
  var synth = window.speechSynthesis;
  var $ = function (s) { return document.querySelector(s); };
  var docEl = $('#doc'), statusEl = $('#status'), nameEl = $('#name');
  var seek = $('#seek'), countEl = $('#count'), remainEl = $('#remain');
  var playBtn = $('#play'), voiceSel = $('#voice'), playerEl = $('.player');
  var pager = $('#pager'), pnum = $('#pnum'), ptotal = $('#ptotal'), pprev = $('#pprev'), pnext = $('#pnext'), pageNums = [];
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';

  var S = [], cum = [], idx = 0, playing = false, token = 0, rate = 1, voice = null, voices = [], fileKey = null, userPickedVoice = false;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function setStatus(msg, err) { statusEl.textContent = msg ? '· ' + msg : ''; statusEl.className = err ? 'err' : ''; }
  var diagEl = $('#diaglog');
  function diag(m) { try { diagEl.textContent += new Date().toLocaleTimeString() + '  ' + m + '\n'; } catch (e) {} }
  window.addEventListener('error', function (e) { diag('ERROR ' + e.message); });
  window.addEventListener('unhandledrejection', function (e) { diag('RECHAZO ' + (e.reason && e.reason.message || e.reason)); });
  diag('inicio · ' + (navigator.userAgent || '').slice(0, 100) + ' · File.text=' + !!(window.File && File.prototype.text) + ' · voz=' + !!window.speechSynthesis);

  /* ---------- Texto a frases ---------- */
  var seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('es', { granularity: 'sentence' }) : null;
  function chunk(s, max) {
    var r = [];
    while (s.length > max) {
      var win = s.slice(0, max), cut = -1, m = Array.from(win.matchAll(/[,;:]\s/g));
      if (m.length) cut = m[m.length - 1].index + 1;
      if (cut < max * 0.4) cut = win.lastIndexOf(' ');
      if (cut <= 0) cut = max;
      r.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) r.push(s);
    return r;
  }
  function sentencesOf(text) {
    var out = [];
    if (seg) { for (var it of seg.segment(text)) out.push(it.segment.trim()); }
    else out = (text.match(/[^.!?…]+[.!?…]+["”»)]*\s*|[^.!?…]+$/g) || [text]).map(function (s) { return s.trim(); });
    var res = [];
    out.filter(Boolean).forEach(function (s) { chunk(s, 240).forEach(function (c) { res.push(c); }); });
    return res;
  }

  /* ---------- Extraccion de texto del PDF ---------- */
  async function pageParas(page) {
    var tc = await page.getTextContent();
    var lines = [], cur = null;
    tc.items.forEach(function (it) {
      if (!('str' in it)) return;
      var y = it.transform[5], h = Math.abs(it.height) || Math.abs(it.transform[3]) || 10;
      if (cur && Math.abs(cur.y - y) < h * 0.5) cur.s += it.str;
      else { cur = { y: y, s: it.str }; lines.push(cur); }
      if (it.hasEOL) cur = null;
    });
    lines = lines.map(function (l) { return { y: l.y, s: l.s.replace(/\s+/g, ' ').trim() }; }).filter(function (l) { return l.s; });
    if (lines.length && /^\d{1,4}$/.test(lines[lines.length - 1].s)) lines.pop();
    if (lines.length && /^\d{1,4}$/.test(lines[0].s)) lines.shift();
    var gaps = [];
    for (var i = 1; i < lines.length; i++) { var g = lines[i - 1].y - lines[i].y; if (g > 0) gaps.push(g); }
    gaps.sort(function (a, b) { return a - b; });
    var med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
    var paras = [], buf = '';
    lines.forEach(function (l, k) {
      if (k > 0) {
        var gap = lines[k - 1].y - l.y;
        if (gap > med * 1.55 || gap < 0) { if (buf) paras.push(buf); buf = l.s; return; }
      }
      if (!buf) buf = l.s;
      else if (/[A-Za-zÁÉÍÓÚáéíóúñ]-$/.test(buf) && /^[a-záéíóúñ]/.test(l.s)) buf = buf.slice(0, -1) + l.s;
      else buf += ' ' + l.s;
    });
    if (buf) paras.push(buf);
    return paras;
  }

  function detectLang(text) {
    var t = ' ' + text.slice(0, 6000).toLowerCase().replace(/[^a-záéíóúñü\s]/g, ' ') + ' ';
    var count = function (words) { return words.reduce(function (n, w) { return n + (t.split(' ' + w + ' ').length - 1); }, 0); };
    var es = count(['de', 'la', 'que', 'el', 'en', 'los', 'del', 'las', 'por', 'con', 'una', 'para']);
    var en = count(['the', 'of', 'and', 'to', 'in', 'is', 'that', 'for', 'with', 'are', 'was', 'this']);
    if (es > en * 1.3 && es > 8) return 'es';
    if (en > es * 1.3 && en > 8) return 'en';
    return null;
  }

  /* ---------- Render ---------- */
  var imageMap = {}, imgMiss = 0, docBase = null;
  function normKey(s) {
    try { s = decodeURIComponent(String(s)); } catch (e) { s = String(s); }
    return s.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/^(\.{1,2}\/)+/, '').replace(/^\/+/, '').toLowerCase();
  }
  function resolveImg(src) {
    if (!src) return null;
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    var k = normKey(src);
    var local = imageMap[k] || imageMap[k.split('/').pop()];
    if (local) return local;
    if (docBase) { try { return new URL(src, docBase).href; } catch (e) {} }
    return null;
  }
  function isImageFile(f) { return /^image\//i.test(f.type) || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(f.name); }
  function addImages(files) {
    files.forEach(function (f) {
      var u = URL.createObjectURL(f);
      var rel = (f.webkitRelativePath || '').split('/').slice(1).join('/');
      if (rel) imageMap[normKey(rel)] = u;
      imageMap[normKey(f.name)] = u;
    });
    diag('imágenes registradas: ' + files.length);
  }
  function missingBox(text) { var d = document.createElement('div'); d.className = 'fig-missing'; d.textContent = text; return d; }
  function renderImage(im, pageN) {
    var fig = document.createElement('figure'); fig.className = 'fig';
    var url = resolveImg(im.src);
    if (url) {
      var img = document.createElement('img');
      img.alt = im.alt || ''; img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('error', function () {
        imgMiss++; img.replaceWith(missingBox('No se pudo cargar la imagen' + (/^https?:/i.test(im.src) ? ' (¿sin conexión o bloqueada?): ' : ': ') + im.src.slice(0, 120)));
      });
      img.src = url; fig.append(img);
    } else {
      imgMiss++;
      fig.append(missingBox('Imagen no cargada: ' + im.src.slice(0, 120) + '. Elige el .md junto con sus imágenes, o usa el botón Carpeta.'));
    }
    if (im.alt && im.alt.length > 1 && !/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(im.alt)) {
      var cap = document.createElement('figcaption'), sp = document.createElement('span');
      sp.className = 's'; sp.textContent = im.alt; sp.dataset.i = S.length;
      S.push({ text: im.alt, page: pageN, el: sp }); cap.append(sp); fig.append(cap);
    }
    docEl.append(fig);
  }
  function renderDoc(pages, showLabels) {
    docEl.textContent = '';
    S = []; imgMiss = 0;
    pageNums = showLabels ? pages.map(function (p) { return p.n; }) : [];
    pages.forEach(function (pg) {
      if (pg.title) {
        var hh = document.createElement('h2'); hh.className = 'sec';
        var hs = document.createElement('span'); hs.className = 's'; hs.textContent = pg.title; hs.dataset.i = S.length;
        S.push({ text: pg.title, page: pg.n, el: hs }); hh.append(hs); docEl.append(hh);
      } else if (showLabels) { var lab = document.createElement('div'); lab.className = 'pg'; lab.textContent = 'Página ' + pg.n; docEl.append(lab); }
      pg.paras.forEach(function (para) {
        if (!Array.isArray(para)) { renderImage(para, pg.n); return; }
        var p = document.createElement('p');
        para.forEach(function (t) {
          var sp = document.createElement('span');
          sp.className = 's'; sp.textContent = t; sp.dataset.i = S.length;
          S.push({ text: t, page: pg.n, el: sp });
          p.append(sp, ' ');
        });
        docEl.append(p);
      });
    });
    cum = new Array(S.length + 1); cum[S.length] = 0;
    for (var i = S.length - 1; i >= 0; i--) cum[i] = cum[i + 1] + S[i].text.length;
    seek.max = Math.max(0, S.length - 1);
    pager.hidden = pageNums.length < 2;
    if (!pager.hidden) { pnum.max = pageNums[pageNums.length - 1]; ptotal.textContent = '/ ' + (cur ? cur.numPages : pageNums[pageNums.length - 1]); }
    idx = 0;
    mark(0, false);
  }

  var SAMPLE = [{ n: null, paras: [
    ['Voz Alta lee tus PDF en voz alta mientras tú haces otra cosa.', 'Abre un archivo con el botón de arriba o arrástralo a esta página, y pulsa reproducir.', 'Todo ocurre en tu navegador, así que el documento no se sube a ningún servidor.'],
    ['La frase que se está leyendo queda resaltada para que puedas seguirla con la vista.', 'Toca cualquier frase para saltar hasta ella.', 'También puedes cambiar la velocidad, elegir otra voz o moverte con la barra de progreso.'],
    ['La barra espaciadora pausa y reanuda la lectura, y las flechas izquierda y derecha cambian de frase.', 'Si vuelves a abrir el mismo PDF, la lectura continúa donde la dejaste.']
  ] }];

  /* ---------- Reproduccion ---------- */
  function mark(i, scroll) {
    var prev = docEl.querySelector('.s.now'); if (prev) prev.classList.remove('now');
    if (!S[i]) { countEl.textContent = '0 / 0'; remainEl.textContent = ''; return; }
    var el = S[i].el; el.classList.add('now');
    if (scroll) {
      var r = el.getBoundingClientRect();
      if (r.top < 90 || r.bottom > window.innerHeight - (playerEl.offsetHeight + 24)) el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
    seek.value = i;
    countEl.textContent = (i + 1) + ' / ' + S.length;
    var mins = cum[i] / (900 * rate);
    remainEl.textContent = mins < 1 ? '< 1 min' : '≈ ' + Math.round(mins) + ' min';
    var pk = pageNums.indexOf(S[i].page);
    if (pk >= 0) pnum.value = S[i].page;
    pprev.disabled = pk <= 0;
    pnext.disabled = pk < 0 || pk >= pageNums.length - 1;
    if (fileKey) lsSet(fileKey, String(i));
  }
  function setPlaying(v) {
    playing = v;
    playBtn.innerHTML = v ? ICON_PAUSE : ICON_PLAY;
    playBtn.setAttribute('aria-label', v ? 'Pausar' : 'Reproducir');
  }
  function speak(i) {
    if (!synth) return;
    if (i < 0 || i >= S.length) { setPlaying(false); return; }
    idx = i; mark(i, true);
    synth.cancel();
    var my = ++token;
    var u = new SpeechSynthesisUtterance(S[i].text);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'es-ES';
    u.rate = rate;
    u.onend = function () {
      if (my !== token || !playing) return;
      if (idx + 1 < S.length) speak(idx + 1); else setPlaying(false);
    };
    u.onerror = function (e) {
      if (my !== token || e.error === 'canceled' || e.error === 'interrupted') return;
      setPlaying(false); setStatus('La voz falló. Prueba con otra voz de la lista.', true);
    };
    setTimeout(function () { if (my === token) synth.speak(u); }, 30);
  }
  function stop() { token++; if (synth) synth.cancel(); setPlaying(false); }
  function toggle() {
    if (!synth) { setStatus('Este navegador no tiene síntesis de voz.', true); return; }
    if (playing) stop(); else { setPlaying(true); speak(idx); }
  }
  function goTo(i) {
    i = Math.max(0, Math.min(S.length - 1, i));
    if (playing) speak(i); else { idx = i; mark(i, true); }
  }

  /* ---------- Voces ---------- */
  var GOOD = /natural|neural|online|premium|enhanced|google|siri/i;
  function loadVoices() {
    if (!synth) return;
    var list = synth.getVoices();
    if (!list.length) return;
    var nav = (navigator.language || 'es').slice(0, 2).toLowerCase();
    var rank = function (v) {
      var l = v.lang.slice(0, 2).toLowerCase();
      return (l === 'es' ? 0 : l === 'en' ? 1 : l === nav ? 2 : 3) * 10 + (GOOD.test(v.name) ? 0 : 5);
    };
    voices = list.slice().sort(function (a, b) { return rank(a) - rank(b) || a.name.localeCompare(b.name); });
    voiceSel.textContent = '';
    voices.forEach(function (v, k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = v.name.replace(/^Microsoft |^Google /, '') + ' · ' + v.lang;
      voiceSel.append(o);
    });
    var saved = lsGet('vozalta:voice');
    var k = saved ? voices.findIndex(function (v) { return v.name === saved; }) : -1;
    if (k >= 0) userPickedVoice = true;
    if (k < 0) k = 0;
    voiceSel.value = k; voice = voices[k];
  }
  function pickVoiceFor(lang) {
    if (userPickedVoice || !lang || !voices.length) return;
    var k = voices.findIndex(function (v) { return v.lang.toLowerCase().indexOf(lang) === 0; });
    if (k >= 0) { voiceSel.value = k; voice = voices[k]; }
  }
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
  else setStatus('Este navegador no tiene síntesis de voz.', true);

  /* ---------- Abrir PDF ---------- */
  var cur = null; // { pdf, name, key, numPages, pages: {n: [[frases]]}, sample, ocrTried }
  var ocrAbort = false, ocrWorker = null;
  var ocrPanel = $('#ocr'), ocrMsg = $('#ocrmsg'), ocrGo = $('#ocrgo'), ocrCancel = $('#ocrcancel'), ocrBar = $('#ocrbar'), ocrLang = $('#ocrlang');

  function pagesList() {
    var out = [];
    for (var n = 1; n <= cur.numPages; n++) if (cur.pages[n] && cur.pages[n].length) out.push({ n: n, paras: cur.pages[n], title: cur.titles ? cur.titles[n] : null });
    return out;
  }
  function missingPages() {
    var out = [];
    for (var n = 1; n <= cur.numPages; n++) if (!cur.pages[n] || !cur.pages[n].length) out.push(n);
    return out;
  }
  function showOcr(msg) { ocrMsg.textContent = msg; ocrPanel.hidden = false; ocrBar.hidden = true; ocrGo.hidden = false; ocrCancel.hidden = true; ocrLang.disabled = false; }

  function showDoc(startIdx, startPage) {
    var list = pagesList();
    fileKey = null;
    nameEl.textContent = cur.name;
    if (!list.length) {
      renderDoc([], false);
      setStatus('no se encontró texto seleccionable', true);
      showOcr('Este PDF parece un escaneo y no tiene texto seleccionable. Puedo reconocerlo con OCR.');
      return;
    }
    renderDoc(list, true);
    var miss = missingPages().length;
    if (miss && !cur.ocrTried) showOcr(miss + (miss > 1 ? ' páginas no tienen' : ' página no tiene') + ' texto seleccionable (imágenes o escaneos). Puedo reconocerlas con OCR.');
    else ocrPanel.hidden = true;
    var lang = detectLang(cur.sample);
    pickVoiceFor(lang);
    var i = startIdx || 0;
    if (startPage != null) { var k = S.findIndex(function (s) { return s.page === startPage; }); if (k >= 0) i = k; }
    if (i < 0 || i >= S.length) i = 0;
    idx = i;
    fileKey = cur.key;
    mark(idx, i > 0);
    var bits = [cur.numPages + (cur.kind === 'text' ? (cur.numPages === 1 ? ' sección' : ' secciones') : ' páginas')];
    if (lang) bits.push('idioma ' + (lang === 'es' ? 'español' : 'inglés'));
    if (cur.ocrTried && cur.kind !== 'text') bits.push('incluye texto por OCR');
    if (imgMiss) bits.push(imgMiss + (imgMiss > 1 ? ' imágenes sin cargar' : ' imagen sin cargar') + ' (elígelas junto con el .md o usa Carpeta)');
    setStatus(bits.join(' · '));
  }

  /* ---------- Markdown y texto plano ---------- */
  function cleanInline(s) {
    return s
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<https?:[^>]+>/g, '')
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(^|[\s(¿¡"“])\*(?=\S)([^*]*?\S)\*(?=$|[\s).,;:!?"”])/g, '$1$2')
      .replace(/(^|[\s(¿¡"“])_(?=\S)([^_]*?\S)_(?=$|[\s).,;:!?"”])/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1')
      .replace(/\s+/g, ' ').trim();
  }
  function splitImages(s) {
    s = s.replace(/\[(!\[[^\]]*\]\([^)]*\))\]\([^)]*\)/g, '$1');
    var re = /!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)|<img\b[^>]*>/gi, out = [], last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      var alt, src;
      if (m[0].charAt(0) === '<') {
        var a = m[0].match(/\balt\s*=\s*("([^"]*)"|'([^']*)')/i), b = m[0].match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i);
        alt = a ? (a[2] || a[3] || '') : ''; src = b ? (b[2] || b[3] || '') : '';
      } else { alt = m[1]; src = m[2]; }
      if (src) out.push({ img: true, alt: cleanInline(alt), src: src });
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  }
  function parseText(text, isMd, fallbackTitle) {
    text = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    if (isMd) text = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    var secs = [], sec = { title: fallbackTitle, paras: [] }, buf = [], inCode = false, fence = '';
    function addText(part) {
      var navOnly = isMd && /^(\s*\[[^\]]*\]\([^)]*\)\s*(\|\s*)?)+$/.test(part);
      var t = isMd ? cleanInline(part) : part;
      if (!navOnly && /[A-Za-zÁ-ÿ0-9]/.test(t)) sec.paras.push(t);
    }
    function flush() {
      if (buf.length) {
        var joined = joinLines(buf);
        if (isMd) splitImages(joined).forEach(function (part) { if (typeof part === 'string') addText(part); else sec.paras.push(part); });
        else addText(joined);
      }
      buf = [];
    }
    function pushSec() { if (sec.paras.length) secs.push(sec); }
    text.split('\n').forEach(function (raw) {
      var line = raw.replace(/\s+$/, ''), m;
      if (isMd) {
        if ((m = line.match(/^\s*(```+|~~~+)/))) {
          if (!inCode) { flush(); inCode = true; fence = m[1][0]; }
          else if (m[1][0] === fence) inCode = false;
          return;
        }
        if (inCode) return;
        if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/))) {
          flush(); pushSec();
          sec = { title: cleanInline(m[1]) || fallbackTitle, paras: [] };
          return;
        }
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*=+\s*$/.test(line)) { flush(); return; }
        if (/^\s*\|/.test(line)) {
          flush();
          if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return;
          var cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cleanInline).filter(Boolean);
          if (cells.length) sec.paras.push(cells.join(', '));
          return;
        }
        if ((m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/))) { flush(); buf = [m[1]]; flush(); return; }
        line = line.replace(/^\s*>+\s?/, '');
      }
      if (!line.trim()) { flush(); return; }
      buf.push(line.trim());
    });
    flush(); pushSec();
    return secs;
  }
  function withTimeout(p, ms, label) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error(label + ' no respondió')); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }
  function readAsText(file) {
    var a = file.text ? withTimeout(file.text(), 3000, 'file.text') : Promise.reject(new Error('no existe file.text'));
    return a.then(function (v) { diag('leído con file.text (' + v.length + ' caracteres)'); return v; }).catch(function (e) {
      diag('file.text falló: ' + e.message + ' · pruebo FileReader');
      return withTimeout(readWithReader(file), 8000, 'FileReader').then(function (v) { diag('leído con FileReader (' + v.length + ' caracteres)'); return v; });
    });
  }
  function readWithReader(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(String(r.result)); };
      r.onerror = function () { rej(r.error || new Error('lectura fallida')); };
      r.readAsText(file, 'utf-8');
    });
  }
  async function openTextFile(file, isMd) {
    stop(); cancelOcr();
    try {
      setStatus('abriendo ' + file.name + '…');
      var raw = await readAsText(file);
      return openRaw(raw, file.name, 'vozalta:pos:' + file.name + ':' + file.size, isMd);
    } catch (e) {
      setStatus('No pude leer ese archivo' + (e && e.message ? ' (' + e.message + ')' : '') + '.', true);
    }
  }
  async function openRaw(raw, fname, key, isMd, base) {
    stop(); cancelOcr();
    docBase = base || null;
    try {
      if (raw.indexOf('\u0000') > -1) { setStatus('Ese archivo no parece de texto.', true); return; }
      var base = fname.replace(/\.[^.]+$/, '');
      var secs = parseText(raw, isMd, base);
      var pages = {}, titles = {}, sample = '';
      secs.forEach(function (s, k) {
        pages[k + 1] = s.paras.map(function (p) { return typeof p === 'string' ? sentencesOf(p) : p; }).filter(function (a) { return a.img || a.length; });
        titles[k + 1] = s.title;
        if (sample.length < 6000) sample += ' ' + s.paras.filter(function (p) { return typeof p === 'string'; }).join(' ');
      });
      if (!secs.length) { setStatus('Ese archivo no tiene texto para leer.', true); return; }
      cur = { pdf: null, kind: 'text', name: fname, key: key, numPages: secs.length, pages: pages, titles: titles, sample: sample, ocrTried: true };
      var saved = parseInt(lsGet(cur.key), 10);
      showDoc(isFinite(saved) ? saved : 0, null);
      if (saved > 0 && S.length) setStatus(statusEl.textContent.replace(/^· /, '') + ' · retomado donde lo dejaste');
      window.scrollTo({ top: 0 });
    } catch (e) {
      setStatus('No pude leer ese texto' + (e && e.message ? ' (' + e.message + ')' : '') + '.', true);
    }
  }

  function toRawUrl(u) {
    u = String(u).trim();
    var m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+?)(?:[?#].*)?$/i);
    if (m) return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3];
    m = u.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?(?:[?#].*)?$/i);
    if (m) return 'https://gist.githubusercontent.com/' + m[1] + '/' + m[2] + '/raw';
    return u.replace(/#.*$/, '');
  }
  async function openUrl(input) {
    var raw = toRawUrl(input);
    if (!/^https?:\/\//i.test(raw)) { setStatus('Escribe una dirección que empiece por https://', true); return; }
    if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/?(tree\/.*)?$/i.test(raw)) { setStatus('Esa dirección es una carpeta o repositorio. Abre un archivo .md concreto.', true); return; }
    stop(); cancelOcr();
    setStatus('descargando…'); diag('descarga: ' + raw);
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 40000);
    try {
      var r = await fetch(raw, { signal: ctl.signal, credentials: 'omit' });
      if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 404 ? ': no existe o el repositorio es privado' : ''));
      var name = 'documento';
      try { name = decodeURIComponent(raw.split(/[?#]/)[0].split('/').pop() || name); } catch (e) {}
      lsSet('vozalta:lasturl', String(input).trim());
      if (/\.pdf$/i.test(name) || /pdf/i.test(r.headers.get('content-type') || '')) {
        var blob = await r.blob(); clearTimeout(timer);
        return openFile(new File([blob], name, { type: 'application/pdf' }));
      }
      var txt = await r.text(); clearTimeout(timer);
      diag('descargado: ' + name + ' (' + txt.length + ' caracteres)');
      var isMd = !/\.(txt|text)$/i.test(name);
      return openRaw(txt, name, 'vozalta:pos:url:' + raw, isMd, raw.slice(0, raw.lastIndexOf('/') + 1));
    } catch (e) {
      clearTimeout(timer);
      var msg = e && e.name === 'AbortError' ? 'tardó demasiado' : (e && /^HTTP/.test(e.message) ? e.message : 'no pude descargarlo. Revisa la dirección y tu conexión. Si abres esta página dentro de Claude, ese entorno bloquea las descargas externas: usa la versión de GitHub Pages o la carpeta local');
      diag('descarga falló: ' + (e && e.message));
      setStatus('No se pudo abrir el enlace: ' + msg + '.', true);
    }
  }

  async function openFile(file) {
    if (!file) return;
    var isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    if (!isPdf) {
      var isMd = /\.(md|markdown|mdown|mkd|mdx)$/i.test(file.name) || /markdown/i.test(file.type);
      var looksText = isMd || /\.(txt|text|rst|org|log)$/i.test(file.name) || /^text\//i.test(file.type) || (!file.type && file.size < 20e6);
      if (!looksText) { setStatus('Usa un archivo PDF, Markdown (.md) o de texto (.txt).', true); return; }
      return openTextFile(file, isMd);
    }
    if (!window.pdfjsLib) { setStatus('No se pudo cargar el lector de PDF. Recarga la página.', true); return; }
    stop(); cancelOcr();
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
      setStatus('leyendo…');
      var data = new Uint8Array(await file.arrayBuffer());
      var pdf = await pdfjsLib.getDocument({ data: data }).promise;
      var pages = {}, sample = '';
      for (var n = 1; n <= pdf.numPages; n++) {
        var page = await pdf.getPage(n);
        var paras = await pageParas(page);
        if (sample.length < 6000) sample += ' ' + paras.join(' ');
        pages[n] = paras.join('').length < 10 ? [] : paras.map(sentencesOf).filter(function (a) { return a.length; });
        if (n % 4 === 0 || n === pdf.numPages) setStatus('leyendo página ' + n + ' de ' + pdf.numPages);
      }
      cur = { pdf: pdf, name: file.name, key: 'vozalta:pos:' + file.name + ':' + file.size, numPages: pdf.numPages, pages: pages, sample: sample, ocrTried: false };
      var saved = parseInt(lsGet(cur.key), 10);
      showDoc(isFinite(saved) ? saved : 0, null);
      if (saved > 0 && S.length) setStatus(statusEl.textContent.replace(/^· /, '') + ' · retomado donde lo dejaste');
      window.scrollTo({ top: 0 });
    } catch (e) {
      setStatus('No pude abrir ese PDF. Puede estar protegido con contraseña o dañado.', true);
    }
  }

  /* ---------- OCR ---------- */
  function joinLines(lines) {
    var buf = '';
    lines.forEach(function (l) {
      if (!buf) buf = l;
      else if (/[A-Za-zÁÉÍÓÚáéíóúñ]-$/.test(buf) && /^[a-záéíóúñ]/.test(l)) buf = buf.slice(0, -1) + l;
      else buf += ' ' + l;
    });
    return buf;
  }
  function ocrParas(text) {
    return text.split(/\n\s*\n/).map(function (b) {
      return joinLines(b.split('\n').map(function (s) { return s.trim(); }).filter(Boolean));
    }).filter(function (p) { return /[A-Za-zÁ-ÿ]{2}/.test(p); });
  }
  function cancelOcr() {
    ocrAbort = true;
    if (ocrWorker) { try { ocrWorker.terminate(); } catch (e) {} }
  }
  async function runOcr() {
    if (!cur) return;
    var mine = cur, miss = missingPages();
    if (!miss.length) return;
    if (!window.Tesseract) { setStatus('No se pudo cargar el motor de OCR en este entorno.', true); return; }
    if (location.protocol === 'file:') { showOcr('Para usar el OCR abre la app con start.bat (servidor local). Si la abres con doble clic en index.html, el navegador bloquea los archivos del motor.'); setStatus('el OCR necesita start.bat', true); return; }
    stop();
    ocrAbort = false;
    ocrGo.hidden = true; ocrCancel.hidden = false; ocrLang.disabled = true; ocrBar.hidden = false; ocrBar.value = 0;
    ocrMsg.textContent = 'Preparando el motor de OCR…';
    var done = 0, worker = null, failed = false;
    try {
      worker = await Tesseract.createWorker(ocrLang.value, 1, {
        workerPath: 'vendor/tesseract/worker.min.js', corePath: 'vendor/tesseract', langPath: 'vendor/tessdata', gzip: true, cacheMethod: 'none',
        logger: function (m) { if (m.status === 'recognizing text') ocrBar.value = Math.round((done + m.progress) / miss.length * 100); }
      });
      ocrWorker = worker;
      for (var k = 0; k < miss.length && !ocrAbort; k++) {
        var n = miss[k];
        ocrMsg.textContent = 'Reconociendo página ' + n + ' (' + (k + 1) + ' de ' + miss.length + ')';
        var page = await mine.pdf.getPage(n);
        var v0 = page.getViewport({ scale: 1 });
        var scale = Math.max(1.5, Math.min(3, 2200 / Math.max(v0.width, v0.height)));
        var vp = page.getViewport({ scale: scale });
        var canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        var res = await worker.recognize(canvas);
        canvas.width = canvas.height = 0;
        mine.pages[n] = ocrParas(res.data.text).map(sentencesOf).filter(function (a) { return a.length; });
        mine.sample += ' ' + res.data.text.slice(0, 1500);
        done++;
        ocrBar.value = Math.round(done / miss.length * 100);
      }
    } catch (e) {
      if (!ocrAbort) failed = true;
    }
    try { if (worker) await worker.terminate(); } catch (e) {}
    ocrWorker = null;
    if (cur !== mine) return;
    if (failed && !done) {
      showOcr('No se pudo iniciar el OCR. Abre la app con start.bat (servidor local) y no con doble clic en index.html: el navegador bloquea los archivos del motor si la página se abre desde el disco.');
      setStatus('falló el OCR', true);
      return;
    }
    mine.ocrTried = true;
    var keepPage = S[idx] ? S[idx].page : null;
    showDoc(0, keepPage);
    if (!S.length) setStatus('el OCR no encontró texto legible', true);
  }

  /* ---------- Eventos ---------- */
  var gotFile = false, docFiles = [];
  function isDocFile(f) { return /\.(pdf|md|markdown|mdown|mkd|mdx|txt|text|rst)$/i.test(f.name) || /^text\//i.test(f.type) || f.type === 'application/pdf'; }
  function handleFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    var imgs = files.filter(isImageFile), docs = files.filter(function (f) { return !isImageFile(f); });
    if (imgs.length) addImages(imgs);
    if (files.length > 1) docs = docs.filter(isDocFile);
    docs.sort(function (a, b) { return (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }); });
    var pick = $('#docpick');
    if (docs.length > 1) {
      docFiles = docs; pick.textContent = '';
      docs.forEach(function (f, k) { var o = document.createElement('option'); o.value = k; o.textContent = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name; pick.append(o); });
      pick.value = 0; pick.hidden = false;
    } else { docFiles = []; pick.hidden = true; }
    if (docs.length) return openFile(docs[0]);
    if (imgs.length && cur && cur.kind === 'text') { stop(); showDoc(idx, null); return; }
    if (imgs.length) { setStatus('imágenes recibidas. Ahora abre el .md que las usa.'); return; }
    setStatus('No encontré archivos para abrir.', true);
  }
  $('#urlform').addEventListener('submit', function (e) { e.preventDefault(); var v = $('#urlin').value.trim(); if (v) openUrl(v); else setStatus('Pega primero una dirección.', true); });
  $('#docpick').addEventListener('change', function () { var f = docFiles[parseInt(this.value, 10)]; if (f) { setStatus('abriendo ' + f.name + '…'); openFile(f); } });
  function onPick(e) {
    var inp = e.target, list = inp.files ? Array.prototype.slice.call(inp.files) : [], f = list[0];
    if (!f || inp.__busy === f) return;
    inp.__busy = f; gotFile = true;
    diag('archivos recibidos: ' + list.length + ' · primero: ' + f.name + ' · tipo="' + f.type + '" · ' + f.size + ' bytes');
    setStatus('abriendo ' + f.name + '…');
    Promise.resolve(handleFiles(list)).catch(function (err) {
      setStatus('No pude abrir ese archivo' + (err && err.message ? ' (' + err.message + ')' : '') + '.', true);
    }).then(function () { inp.__busy = null; try { inp.value = ''; } catch (x) {} });
  }
  ['#file', '#file2', '#folder'].forEach(function (sel) {
    var el = $(sel);
    el.addEventListener('change', onPick);
    el.addEventListener('input', onPick);
    el.addEventListener('click', function () {
      gotFile = false; diag('toque en ' + sel + ' (se abre el selector)');
      window.addEventListener('focus', function back() {
        window.removeEventListener('focus', back);
        setTimeout(function () {
          if (gotFile) return;
          diag('el selector se cerró sin entregar archivo');
          setStatus('El selector no entregó ningún archivo. Arrastra el archivo a la zona de carga o usa "Pegar texto".', true);
        }, 1500);
      });
    });
  });
  $('#pastego').addEventListener('click', function () {
    var t = $('#pastetxt').value;
    if (!t.trim()) { setStatus('Pega primero el texto.', true); return; }
    setStatus('abriendo texto pegado…');
    openRaw(t, 'Texto pegado', 'vozalta:pos:pegado:' + t.length, $('#pastemd').checked);
  });
  var drop = $('#drop');
  ['dragenter', 'dragover'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  document.addEventListener('drop', function (e) {
    var list = e.dataTransfer ? Array.prototype.slice.call(e.dataTransfer.files) : [], f = list[0];
    diag('soltar archivos: ' + (f ? list.length + ' · primero: ' + f.name : 'ninguno (' + (e.dataTransfer && e.dataTransfer.types ? Array.prototype.join.call(e.dataTransfer.types, ',') : '?') + ')'));
    if (f) { gotFile = true; setStatus('abriendo ' + f.name + '…'); handleFiles(list); }
  });

  ocrGo.addEventListener('click', runOcr);
  ocrCancel.addEventListener('click', cancelOcr);
  playBtn.addEventListener('click', toggle);
  $('#prev').addEventListener('click', function () { goTo(idx - 1); });
  $('#next').addEventListener('click', function () { goTo(idx + 1); });
  docEl.addEventListener('click', function (e) {
    var s = e.target.closest('.s'); if (!s || !synth) return;
    setPlaying(true); speak(parseInt(s.dataset.i, 10));
  });
  seek.addEventListener('input', function () { var i = parseInt(seek.value, 10); countEl.textContent = (i + 1) + ' / ' + S.length; });
  seek.addEventListener('change', function () { goTo(parseInt(seek.value, 10)); });
  function startOf(page) { return S.findIndex(function (s) { return s.page === page; }); }
  function goPage(delta) {
    var k = pageNums.indexOf(S[idx] && S[idx].page);
    if (k < 0 || pageNums[k + delta] == null) return;
    goTo(startOf(pageNums[k + delta]));
  }
  pprev.addEventListener('click', function () { goPage(-1); });
  pnext.addEventListener('click', function () { goPage(1); });
  pnum.addEventListener('change', function () {
    var n = parseInt(pnum.value, 10);
    if (!isFinite(n) || !pageNums.length) { mark(idx, false); return; }
    var t = pageNums.find(function (x) { return x >= n; });
    if (t == null) t = pageNums[pageNums.length - 1];
    goTo(startOf(t));
    pnum.value = t;
  });
  $('#speeds').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    rate = parseFloat(b.dataset.r);
    this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    mark(idx, false);
    if (playing) speak(idx);
  });
  voiceSel.addEventListener('change', function () {
    voice = voices[parseInt(voiceSel.value, 10)]; userPickedVoice = true;
    lsSet('vozalta:voice', voice.name);
    if (playing) speak(idx);
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || t === 'BUTTON') return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') { if (e.shiftKey) goPage(1); else goTo(idx + 1); }
    else if (e.key === 'ArrowLeft') { if (e.shiftKey) goPage(-1); else goTo(idx - 1); }
  });
  window.addEventListener('pagehide', function () { if (synth) synth.cancel(); });

  function fitPad() { document.body.style.paddingBottom = (playerEl.offsetHeight + 24) + 'px'; }
  fitPad();
  if (window.ResizeObserver) new ResizeObserver(fitPad).observe(playerEl);
  setPlaying(false);
  renderDoc(SAMPLE, false);
  setStatus('ejemplo, abre un PDF para escuchar el tuyo');
  try {
    var qs = new URLSearchParams(location.search), q = qs.get('md') || qs.get('url');
    var last = lsGet('vozalta:lasturl');
    if (last) $('#urlin').value = last;
    if (q) { $('#urlin').value = q; openUrl(q); }
  } catch (e) {}
})();
