/*
 * Planer v1.5.0
 * Autor: Mavionis
 *
 * Strona informacji o wiosce celu: uruchom skrypt.
 *
 * Dwa tryby:
 *  - Atak: z każdej wioski off na ustawioną godzinę – sam off albo kareta (off + 3, 4, 5 albo ile chcesz szlachciców
 *    z tej samej wioski, wysłane razem; odstępy ms między nimi ustala gra; eskorta każdego szlachcica odejmowana od offa),
 *  - Klin: wojsko (ofensywne, defensywne, wszystkie albo własne) z każdej wioski wchodzi pomiędzy grube –
 *    X ms przed ostatnim grubym z karety wroga.
 * Wojska w domu ze wszystkich wiosek wybranej grupy (Przegląd > Wojska, wszystkie strony), dokładny zegar gry
 * (milisekundy), czas podróży zaokrąglany do pełnej sekundy jak w grze, eskorta każdego szlachcica
 * (domyślnie 20 toporników + 20 LK) odejmowana od wojsk wioski. Wojska w offie jednym kliknięciem:
 * ofensywne (domyślnie), defensywne, wszystkie albo własny wybór. Link otwiera Plac z wpisanymi wojskami –
 * atak klikasz sam. Rozpiska BB: off i jego szlachcice w jednym wierszu.
 * Wejście: dwa okienka – data (domyślnie dzisiaj, sama przechodzi na jutro, gdy godzina już minęła) i godzina.
 * Godzinę wpisujesz ręcznie albo (w Klinie) bierzesz z ataków: wklej listę ataków (albo uruchom na stronie, na której
 * je widać) i „Pobierz z ataków” wpisze czas ostatniego grubego z karety (ostatni z serii ataków z jednej wioski
 * co ≤ 1 s). Ręczny wpis zostaje, dopóki sam nie klikniesz „Pobierz z ataków”.
 * Skrypt niczego nie wysyła ani nie klika. Zapytania: Przegląd wojsk i prędkości jednostek (interface.php) z serwera gry.
 */
(function () {
	'use strict';

	const NAME = 'Planer';
	const VERSION = 'v1.5.0';
	const NS = 'PlanerAtakow';
	const UNITS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];
	const POP = { spear: 1, sword: 1, axe: 1, archer: 1, spy: 2, light: 4, marcher: 5, heavy: 6, ram: 5, catapult: 8, knight: 10, snob: 100 };
	const LABEL = { spear: 'Pik', sword: 'Miecz', axe: 'Top', archer: 'Łuk', spy: 'Zw', light: 'LK', marcher: 'ŁnK', heavy: 'CK', ram: 'Tar', catapult: 'Kat', knight: 'Ryc', snob: 'Szl' };
	const DEFAULTS = {
		mode: 'atak', landing: '', nobles: 4, klinBefore: 50, escAxe: 20, escLight: 20, minPop: 0, group: '0', preset: 'off',
		offUnits: ['axe', 'light', 'marcher', 'heavy', 'ram', 'catapult']
	};

	// ---------- Narzędzia ----------
	const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const notify = (msg, type = 'InfoMessage') => {
		if (typeof UI !== 'undefined' && UI[type]) { UI[type](esc(msg)); } else { alert(msg); }
	};
	const storageKey = key => `${NS}_${game_data.world}_${game_data.player.id}_${key}`;
	const storageGet = key => { try { return JSON.parse(localStorage.getItem(storageKey(key))); } catch (e) { return null; } };
	const storageSet = (key, val) => { try { localStorage.setItem(storageKey(key), JSON.stringify(val)); } catch (e) { /* brak miejsca */ } };
	const pad = (n, l = 2) => String(n).padStart(l, '0');
	const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

	// Zegar gry: Timing.getCurrentServerTime() to dokładny czas serwera (ms od 1970, UTC).
	// Godziny pokazujemy w czasie serwera: UTC + server_utc_diff.
	const utcDiff = () => (typeof server_utc_diff !== 'undefined' ? Number(server_utc_diff) : 3600) * 1000;
	const nowMs = () => (typeof Timing !== 'undefined' && Timing.getCurrentServerTime ? Timing.getCurrentServerTime() : Date.now());
	function fmtTime(ms, withDate) {
		const d = new Date(ms + utcDiff());
		const t = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}:${pad(d.getUTCMilliseconds(), 3)}`;
		return withDate ? `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${t}` : t;
	}
	// „27.11 20:15:30:250” – do tabeli (rozkazy na dalekie cele wychodzą nawet dzień wcześniej)
	const fmtShort = ms => fmtTime(ms, true).replace(/\.\d{4} /, ' ');
	// „27.11.2026 20:15:30:250” (czas serwera) → ms; milisekundy opcjonalne
	function parseLanding(text) {
		const m = String(text).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})(?:[:.,](\d{1,3}))?$/);
		if (!m) { return null; }
		const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
		return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6], ms) - utcDiff();
	}
	// „27.11.2026 20:15:30:250” ↔ ['27.11.2026', '20:15:30:250']
	const splitLanding = text => { const m = String(text || '').trim().match(/^(\S+)\s+(\S+)$/); return m ? [m[1], m[2]] : ['', String(text || '').trim()]; };
	const todayStr = (plusDays = 0) => fmtTime(nowMs() + plusDays * 86400000, true).slice(0, 10);

	// ---------- Czas z ataków (kareta) ----------
	// wiersz: „… (416|471) K44 … Czas przybycia: 19.11.26 10:22:55:237 …” – zwykły tekst albo z linkami [..](..)
	const INCOMING_RE = /\((\d{1,3}\|\d{1,3})\)[^\n]*?Czas przybycia:\s*(\d{2})\.(\d{2})\.(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})[:.,](\d{1,3})/;
	const KARETA_GAP_MS = 1000;
	// zwraca czas ostatniego grubego jako tekst do pola wejścia („19.11.2026 10:22:55:237”) albo null
	function lastNobleFromLines(lines) {
		const cmds = lines.map(line => {
			const m = String(line).match(INCOMING_RE);
			if (!m) { return null; }
			const year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
			const ms = m[8].padEnd(3, '0');
			return {
				coords: m[1],
				t: Date.UTC(year, +m[3] - 1, +m[2], +m[5], +m[6], +m[7], +ms),   // tylko do porównań (czas serwera)
				text: `${m[2]}.${m[3]}.${year} ${pad(m[5])}:${m[6]}:${m[7]}:${ms}`
			};
		}).filter(Boolean).sort((a, b) => a.t - b.t);
		// atak należy do karety, gdy wchodzi ≤ 1 s po poprzednim z tej samej wioski; bierzemy ostatni taki
		let last = null;
		cmds.forEach((c, i) => {
			const prev = cmds.slice(0, i).reverse().find(p => p.coords === c.coords);
			if (prev && c.t - prev.t <= KARETA_GAP_MS) { last = c; }
		});
		return last ? last.text : null;
	}
	// ataki z wklejki, a gdy pusta – z wierszy tabel na bieżącej stronie
	function lastNobleTime(pasted) {
		if (String(pasted || '').trim()) { return lastNobleFromLines(String(pasted).split('\n')); }
		return lastNobleFromLines($('#content_value tr').map(function () { return this.innerText.replace(/\s+/g, ' '); }).get());
	}

	function fmtLeft(ms) {
		if (ms < 0) { return 'minęło'; }
		const s = Math.floor(ms / 1000);
		return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}.${Math.floor((ms % 1000) / 100)}`;
	}

	function loadSettings() {
		const s = Object.assign({}, DEFAULTS, storageGet('ustawienia') || {});
		s.nobles = Math.min(num(s.nobles, DEFAULTS.nobles), 10);
		s.escAxe = num(s.escAxe, DEFAULTS.escAxe);
		s.escLight = num(s.escLight, DEFAULTS.escLight);
		s.minPop = num(s.minPop, 0);
		if (!['atak', 'klin'].includes(s.mode)) { s.mode = 'atak'; }
		s.klinBefore = num(s.klinBefore, DEFAULTS.klinBefore);
		if (!['off', 'deff', 'all', 'custom'].includes(s.preset)) { s.preset = 'off'; }
		if (!Array.isArray(s.offUnits)) { s.offUnits = DEFAULTS.offUnits.slice(); }
		return s;
	}

	// ---------- Cel ----------
	function readTarget() {
		if (game_data.screen !== 'info_village') { return null; }
		const id = Number((location.search.match(/[?&]id=(\d+)/) || [])[1] || (typeof VillageInfo !== 'undefined' ? VillageInfo.village_id : 0));
		let x = 0, y = 0;
		$('#content_value table.vis td').each(function () {
			const m = $(this).text().trim().match(/^(\d{1,3})\|(\d{1,3})$/);
			if (m && !x) { x = Number(m[1]); y = Number(m[2]); }
		});
		if (!id || !x) { return null; }
		return { id, x, y, name: $.trim($('#content_value h2').first().text()) || `${x}|${y}` };
	}

	// ---------- Dane z serwera gry ----------
	async function unitSpeeds() {
		const cached = storageGet('predkosci');
		if (cached && cached.snob) { return cached; }
		const xml = await $.get('/interface.php?func=get_unit_info');
		const speeds = {};
		$(xml).find('config').children().each(function () {
			const v = parseFloat($(this).find('speed').first().text());
			if (v > 0) { speeds[this.nodeName] = v; }
		});
		if (!speeds.snob) { throw 'nie odczytałem prędkości jednostek.'; }
		storageSet('predkosci', speeds);
		return speeds;
	}

	// Przegląd > Wojska „Wszystkie”, wszystkie strony; pierwszy wiersz każdej wioski = własne wojska w wiosce
	async function loadVillages(group) {
		const t = game_data.player.sitter && Number(game_data.player.sitter) > 0 ? '&t=' + game_data.player.id : '';
		const html = await $.get(`/game.php?village=${game_data.village.id}${t}&screen=overview_villages&mode=units&type=complete&group=${encodeURIComponent(group)}&page=-1`);
		const doc = $('<div>').append($.parseHTML(html));
		const table = doc.find('#units_table');
		if (!table.length) { throw 'nie odczytałem Przeglądu wojsk (wymaga Konta Premium).'; }
		const cols = table.find('thead th img').map(function () {
			return (String($(this).attr('src') || '').match(/unit_(\w+)\./) || [])[1] || null;
		}).get();
		const villages = [];
		table.find('tbody').each(function () {
			const qe = $(this).find('.quickedit-vn').first();
			const m = qe.find('.quickedit-label').text().match(/\((\d{1,3})\|(\d{1,3})\)\s*K\d+\s*$/);
			if (!qe.length || !m) { return; }
			const units = {};
			$(this).find('tr').first().find('td.unit-item').each(function (i) { if (cols[i]) { units[cols[i]] = parseInt($(this).text(), 10) || 0; } });
			const label = qe.find('.quickedit-label');
			villages.push({ id: Number(qe.data('id')), name: String(label.attr('data-text') || '').trim(), x: +m[1], y: +m[2], units });
		});
		const groups = doc.find('.group-menu-item').map(function () {
			return { id: String($(this).data('group-id')), name: $(this).text().replace(/[[\]<>]/g, '').trim() };
		}).get();
		return { villages, groups };
	}

	// ---------- Obliczenia ----------
	// jednostki w offie: gotowy wybór albo własny (zaznaczenia schowane pod „inne jednostki”)
	const OFF_UNITS = ['axe', 'light', 'marcher', 'heavy', 'ram', 'catapult'];
	const DEFF_UNITS = ['spear', 'sword', 'archer', 'heavy'];
	const offUnitsOf = s => (s.preset === 'all' ? UNITS.filter(n => n !== 'snob' && n !== 'knight')
		: s.preset === 'custom' ? s.offUnits : s.preset === 'deff' ? DEFF_UNITS : OFF_UNITS);
	const travelMs = (dist, speed) => Math.round(dist * speed * 60) * 1000;   // gra zaokrągla do pełnej sekundy

	// wojska wioski po odjęciu eskorty k szlachciców; off z zaznaczonych jednostek
	function villageInfo(v, target, s, speeds, k) {
		const u = v.units;
		const dist = Math.hypot(v.x - target.x, v.y - target.y);
		const left = Object.assign({}, u, { axe: (u.axe || 0) - k * s.escAxe, light: (u.light || 0) - k * s.escLight });
		const off = {};
		offUnitsOf(s).forEach(n => { if (n !== 'snob' && left[n] > 0) { off[n] = left[n]; } });
		const pop = Object.keys(off).reduce((t, n) => t + off[n] * POP[n], 0);
		const offTravel = travelMs(dist, Math.max(0, ...Object.keys(off).map(n => speeds[n] || 0)));
		const escort = { snob: 1 };
		if (s.escAxe) { escort.axe = s.escAxe; }
		if (s.escLight) { escort.light = s.escLight; }
		const nobleTravel = travelMs(dist, Math.max(...Object.keys(escort).map(n => speeds[n] || 0)));
		return { dist, off, pop, offTravel, escort, nobleTravel };
	}
	// ilu szlachciców wioska może wysłać z pełną eskortą
	const maxNobles = (v, s) => {
		let k = v.units.snob || 0;
		while (k > 0 && ((v.units.axe || 0) < k * s.escAxe || (v.units.light || 0) < k * s.escLight)) { k--; }
		return k;
	};

	// tryb Atak: z każdej wioski off na tę samą godzinę
	function planAttacks(villages, target, s, speeds, landing) {
		return villages.map(v => {
			const i = villageInfo(v, target, s, speeds, 0);
			return { v, dist: i.dist, off: i.pop > 0 ? { units: i.off, pop: i.pop, land: landing, send: landing - i.offTravel } : null };
		}).filter(r => r.off && r.off.pop >= s.minPop).sort((a, b) => a.off.send - b.off.send);
	}

	// tryb Atak z karetą: z każdej wioski, która ma n szlachciców z eskortą – jedna wysyłka (off + szlachcice razem).
	// Kareta idzie tempem najwolniejszej jednostki (szlachcic), odstępy ms między rozkazami ustala gra.
	function planKarety(villages, target, s, speeds, landing) {
		const n = s.nobles;
		return villages.filter(v => n > 0 && maxNobles(v, s) >= n).map(v => {
			const i = villageInfo(v, target, s, speeds, n);
			const travel = Math.max(i.offTravel, i.nobleTravel);
			const cmd = { kind: 'Kareta', units: i.off, pop: i.pop, land: landing, send: landing - travel };
			return { v, dist: i.dist, pop: i.pop, off: i.off, cmd };
		}).filter(r => r.pop > 0 && r.pop >= s.minPop).sort((a, b) => b.pop - a.pop);
	}

	// Plac z wpisanymi wojskami (ten sam mechanizm co „Wstaw na plac” w symulatorze) – atak klika gracz
	function placeLink(v, target, units) {
		const t = game_data.player.sitter && Number(game_data.player.sitter) > 0 ? '&t=' + game_data.player.id : '';
		return `/game.php?village=${v.id}${t}&screen=place&target=${target.id}&from=simulator` +
			Object.keys(units).map(n => `&att_${n}=${units[n]}`).join('');
	}

	function bbAttacks(rows, target, landing, title = 'wejście') {
		return `Cel: [coord]${target.x}|${target.y}[/coord] – ${title}: ${fmtTime(landing, true)}\n[table][**]Wioska[||]Wysyłka[||]Populacja[/**]\n` +
			rows.map(r => `[*][coord]${r.v.x}|${r.v.y}[/coord][|]${fmtTime(r.off.send, true)}[|]${r.off.pop}`).join('\n') + '\n[/table]';
	}
	function bbKarety(rows, target, s, landing) {
		return `Cel: [coord]${target.x}|${target.y}[/coord] – kareta (off + ${s.nobles} szl.): wejście ${fmtTime(landing, true)}\n` +
			'[table][**]Wioska[||]Wysyłka karety[||]Off (pop.)[||]Szlachcice[/**]\n' +
			rows.map(r => `[*][coord]${r.v.x}|${r.v.y}[/coord][|]${fmtTime(r.cmd.send, true)}[|]${r.pop}[|]${s.nobles}`).join('\n') + '\n[/table]';
	}
	// ---------- Panel ----------
	function render(state) {
		const { s, target, groups } = state;
		$('#' + NS).remove();
		if (!$('#' + NS + '_css').length) {
			$('head').append(`<style id="${NS}_css">#${NS} label{display:inline;margin:0 6px 0 0;white-space:nowrap}#${NS} input{vertical-align:middle}
				#${NS} small{color:#5a4a2a}#${NS} td.num{text-align:right}#${NS} .pk-ok{background:#c8e6b0}#${NS} .pk-late{color:#999;text-decoration:line-through}
				#${NS} .pk-soon{color:#b00;font-weight:bold}#${NS} .pk-zero{color:#bbb}#${NS} .pk-off{font-weight:bold}#${NS} tr.pk-sel td{background:#f4e0a8}</style>`);
		}
		const unitBoxes = UNITS.filter(n => n !== 'snob' && n !== 'knight' && game_data.units.includes(n)).map(n =>
			`<label><input type="checkbox" class="${NS}_unit" value="${n}" ${s.offUnits.includes(n) ? 'checked' : ''}> ${LABEL[n]}</label>`).join('');
		const groupOpts = (groups.length ? groups : [{ id: '0', name: 'wszystkie' }]).map(g =>
			`<option value="${esc(g.id)}" ${String(g.id) === String(s.group) ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
		$($('#content_value').length ? '#content_value' : '#mobileContent').first().prepend(`
			<div id="${NS}" class="vis" style="padding:8px;margin-bottom:10px">
				<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small> <span style="float:right;font-size:12px">Zegar gry: <b id="${NS}_clock"></b></span></h3>
				<table class="vis" style="width:100%">
					<tr><th colspan="2">Cel: ${esc(target.name)} (${target.x}|${target.y})</th></tr>
					<tr><td style="width:170px">Rodzaj</td><td>
						<label><input type="radio" name="${NS}_mode" value="atak" ${s.mode === 'atak' ? 'checked' : ''}> <b>Atak</b></label> <small>– off z każdej wioski o tej samej godzinie: sam off albo kareta (off + szlachcice z tej samej wioski)</small><br>
						<label><input type="radio" name="${NS}_mode" value="klin" ${s.mode === 'klin' ? 'checked' : ''}> <b>Klin</b></label> <small>– wojsko z każdej wioski wchodzi pomiędzy grube: tuż przed ostatnim grubym z karety</small></td></tr>
					<tr><td>${s.mode === 'klin' ? 'Ostatni gruby (wejście)' : 'Wejście offa'}</td><td>
						<input type="text" id="${NS}_ldate" value="${esc(state.ldate || todayStr())}" placeholder="dd.mm.rrrr" style="width:80px" title="data (czas serwera)">
						<input type="text" id="${NS}_ltime" value="${esc(splitLanding(s.landing)[1])}" placeholder="20:15:30:000" style="width:95px" title="godzina gg:mm:ss:mmm (czas serwera)">
						<small>– data i godzina (czas serwera), ms opcjonalnie</small>
						<span class="pk-klinonly"><button type="button" id="${NS}_fetch" class="btn" style="margin-left:6px">Pobierz z ataków</button>
						<small id="${NS}_fetchinfo" style="margin-left:4px"></small><br>
						<textarea id="${NS}_incomings" rows="3" style="width:98%;margin-top:4px" placeholder="Wklej ataki z gry (opcjonalnie) – wpisze się czas ostatniego grubego z karety. Puste pole = ataki ze strony."></textarea></span></td></tr>
					<tr class="pk-klinonly"><td>Klin wchodzi</td><td><input type="text" id="${NS}_klinbefore" value="${s.klinBefore}" style="width:40px"> ms przed ostatnim grubym</td></tr>
					<tr class="pk-atakonly"><td>Kareta</td><td>za offem wyślij <input type="text" id="${NS}_nobles" value="${s.nobles}" style="width:25px"> szlachciców
						${[0, 3, 4, 5].map(k => `<a href="#" class="${NS}_nq" data-n="${k}" style="${k === s.nobles ? 'font-weight:bold' : ''}">[${k ? k : 'sam off'}]</a>`).join(' ')}
						<small>(albo wpisz ile chcesz; 0 = sam off)</small>; eskorta na szlachcica:
						<input type="text" id="${NS}_escaxe" value="${s.escAxe}" style="width:35px"> Top +
						<input type="text" id="${NS}_esclight" value="${s.escLight}" style="width:35px"> LK</td></tr>
					<tr><td style="vertical-align:top">${s.mode === 'klin' ? 'Wojska w klinie' : 'Wojska w offie'}</td><td>
						<label><input type="radio" name="${NS}_preset" value="off" ${s.preset === 'off' ? 'checked' : ''}> ofensywne</label> <small>(Top, LK, ŁnK, CK, tarany, katapulty)</small>
						<label><input type="radio" name="${NS}_preset" value="deff" ${s.preset === 'deff' ? 'checked' : ''}> defensywne</label> <small>(Pik, Miecz, Łuk, CK)</small>
						<label><input type="radio" name="${NS}_preset" value="all" ${s.preset === 'all' ? 'checked' : ''}> wszystkie</label>
						<label><input type="radio" name="${NS}_preset" value="custom" ${s.preset === 'custom' ? 'checked' : ''}> własne:</label>
						<span id="${NS}_custom" style="${s.preset === 'custom' ? '' : 'display:none'}">${unitBoxes}</span>
						<br><small class="pk-atakonly">Przy karecie od toporników i LK odejmowana jest eskorta szlachciców z tej wioski.</small></td></tr>
					<tr><td>Wioski</td><td>grupa <select id="${NS}_group">${groupOpts}</select>
						&nbsp; off co najmniej <input type="text" id="${NS}_minpop" value="${s.minPop}" style="width:50px"> populacji</td></tr>
				</table>
				<div id="${NS}_out" style="margin-top:6px"></div>
			</div>`);
		$(`#${NS} .pk-klinonly`).toggle(s.mode === 'klin');
		$(`#${NS} .pk-atakonly`).toggle(s.mode === 'atak');
		// data + godzina → „dd.mm.rrrr gg:mm:ss:mmm”; bez ręcznej daty: dzisiaj, a gdy godzina już minęła – jutro
		const readLanding = () => {
			const time = String($(`#${NS}_ltime`).val()).trim();
			if (!time) { return ''; }
			let date = String($(`#${NS}_ldate`).val()).trim() || todayStr();
			if (!state.dateManual && date === todayStr()) {
				const t = parseLanding(`${date} ${time}`);
				if (t !== null && t < nowMs()) { date = todayStr(1); $(`#${NS}_ldate`).val(date); }
			}
			state.ldate = date;
			return `${date} ${time}`;
		};
		const read = () => ({
			mode: $(`input[name=${NS}_mode]:checked`).val() || 'atak',
			klinBefore: num($(`#${NS}_klinbefore`).val(), DEFAULTS.klinBefore),
			landing: readLanding(),
			nobles: Math.min(num($(`#${NS}_nobles`).val(), DEFAULTS.nobles), 10),
			escAxe: num($(`#${NS}_escaxe`).val(), DEFAULTS.escAxe), escLight: num($(`#${NS}_esclight`).val(), DEFAULTS.escLight),
			minPop: num($(`#${NS}_minpop`).val(), 0), group: String($(`#${NS}_group`).val()),
			preset: $(`input[name=${NS}_preset]:checked`).val() || 'off',
			offUnits: $(`.${NS}_unit:checked`).map(function () { return this.value; }).get()
		});
		// zmiana ustawień: przelicz
		$('#' + NS).on('input change', 'table:first input', function () {
			const modeChanged = this.name === `${NS}_mode` || this.name === `${NS}_preset`;
			if (this.name === `${NS}_preset`) { $(`#${NS}_custom`).toggle(this.value === 'custom'); }
			state.s = read(); storageSet('ustawienia', state.s);
			if (modeChanged) { render(state); return; }
			draw(state);
		});
		// szybki wybór liczby szlachciców: 3 / 4 / 5 (albo wpisz dowolną w polu)
		$('#' + NS).on('click', `.${NS}_nq`, function (e) {
			e.preventDefault();
			$(`#${NS}_nobles`).val($(this).data('n')).trigger('input');
			$(`#${NS} .${NS}_nq`).css('font-weight', '').filter(this).css('font-weight', 'bold');
		});
		// czas z ataków: wklejka wpisuje sama, chyba że godzinę wpisano ręcznie; przycisk zawsze nadpisuje
		const fillFromIncomings = force => {
			const t = lastNobleTime($(`#${NS}_incomings`).val());
			const info = $(`#${NS}_fetchinfo`);
			if (!t) { if (force) { info.text('nie znaleziono karety – wpisz godzinę ręcznie'); } return; }
			if (!force && state.landingManual) { info.text(`ostatni gruby: ${t} (zostawiam ręczną godzinę)`); return; }
			const [d, tm] = splitLanding(t);
			$(`#${NS}_ldate`).val(d); $(`#${NS}_ltime`).val(tm);
			state.ldate = d; state.dateManual = true;
			state.landingManual = false;
			info.text('z ataków');
			state.s = read(); storageSet('ustawienia', state.s);
			draw(state);
		};
		$('#' + NS).on('input', `#${NS}_ltime, #${NS}_ldate`, function () {
			state.landingManual = true; $(`#${NS}_fetchinfo`).text('ręcznie');
			if (this.id === `${NS}_ldate`) { state.dateManual = true; }
		});
		$('#' + NS).on('input', `#${NS}_incomings`, () => fillFromIncomings(false));
		$('#' + NS).on('click', `#${NS}_fetch`, e => { e.preventDefault(); fillFromIncomings(true); });
		$('#' + NS).on('change', `#${NS}_group`, async () => {
			state.s = read(); storageSet('ustawienia', state.s);
			$(`#${NS}_out`).html('<p>Wczytuję wojska z grupy…</p>');
			try { Object.assign(state, await loadVillages(state.s.group)); draw(state); }
			catch (ex) { $(`#${NS}_out`).html(`<p style="color:#b00"><b>${esc(typeof ex === 'string' ? ex : 'nie udało się wczytać wojsk.')}</b></p>`); }
		});
		$('#' + NS).on('click', `#${NS}_bb`, function (e) {
			e.preventDefault();
			const box = $(`#${NS}_bbbox`).show().find('textarea');
			box.val(state.bb || '').trigger('focus').trigger('select');
			try { navigator.clipboard && navigator.clipboard.writeText(state.bb || '').catch(() => {}); } catch (ex) { /* ręczne kopiowanie */ }
		});
		draw(state);
		startClock();
	}

	const unitHeads = () => UNITS.filter(n => game_data.units.includes(n) && n !== 'knight');
	const unitCells = (v, off) => unitHeads().map(n => {
		const c = v.units[n] || 0;
		return `<td class="num ${c ? (off && off[n] || n === 'snob' ? 'pk-off' : '') : 'pk-zero'}">${c}</td>`;
	}).join('');
	const cmdCell = (c, v, target, label) => (c
		? `<td class="pk-cmd" data-send="${c.send}"><a href="${placeLink(v, target, c.units)}">${label}</a><br><small>${fmtShort(c.send)}</small><br><span class="pk-cd"></span></td>`
		: '<td></td>');

	function draw(state) {
		const { s, target, speeds, villages } = state;
		const out = $(`#${NS}_out`);
		const landing = parseLanding(s.landing);
		if (!s.landing) { out.html(`<p>Wpisz ${s.mode === 'klin' ? 'czas ostatniego grubego' : 'godzinę wejścia offa'}.</p>`); return; }
		if (landing === null) { out.html('<p style="color:#b00"><b>Godzina wejścia: wpisz np. 27.11.2026 20:15:30:000</b></p>'); return; }
		const heads = unitHeads().map(n => `<th><img src="${image_base}unit/unit_${n}.webp" title="${n}" alt="${LABEL[n]}"></th>`).join('');
		const bbLink = `<a href="#" id="${NS}_bb">[rozpiska BB]</a>
			<div id="${NS}_bbbox" style="display:none;margin:4px 0"><textarea rows="5" style="width:98%" readonly></textarea><br>
				<small>Skopiowane do schowka (jeśli przeglądarka pozwoliła).</small></div>`;
		const foot = '<p style="margin:4px 0 0 0"><small>Na zielono: rozkaz jeszcze zdąży. Link otwiera Plac z wpisanymi wojskami i celem – atak wysyłasz sam, o godzinie z tabeli.</small></p>';

		if (s.mode === 'klin' || s.nobles === 0) {   // klin albo sam off: z każdej wioski jeden rozkaz
			const klin = s.mode === 'klin';
			const land = klin ? landing - s.klinBefore : landing;
			const rows = planAttacks(villages, target, s, speeds, land);
			state.bb = bbAttacks(rows, target, land, klin ? `klin (${s.klinBefore} ms przed ostatnim grubym ${fmtTime(landing)})` : 'wejście');
			out.html(`<p style="margin:0 0 4px 0">${klin ? 'Klinów' : 'Ataków'}: <b>${rows.length}</b> z ${villages.length} wiosek, wejście: <b>${fmtTime(land, true)}</b>${klin ? ` (${s.klinBefore} ms przed ostatnim grubym)` : ''}. ${bbLink}</p>
				<div style="overflow-x:auto"><table class="vis" style="width:100%"><tr><th>Wioska</th>${heads}<th>Pop.</th><th>Atak</th></tr>
				${rows.map(r => `<tr><td><b>${esc(r.v.name)}</b><br><small>${r.v.x}|${r.v.y} · ${r.dist.toFixed(1).replace('.', ',')} pola</small></td>
					${unitCells(r.v, r.off.units)}<td class="num">${r.off.pop}</td>${cmdCell(r.off, r.v, target, klin ? 'Klin' : 'Atak')}</tr>`).join('')
					|| `<tr><td colspan="${unitHeads().length + 3}"><small>żadna wioska nie spełnia warunków</small></td></tr>`}
				</table></div>${foot}`);
			tick();
			return;
		}

		{   // atak z karetą
			const rows = planKarety(villages, target, s, speeds, landing);
			state.bb = bbKarety(rows, target, s, landing);
			out.html(`<p style="margin:0 0 4px 0">Kareta – off + <b>${s.nobles}</b> szlachciców z jednej wioski, wejście <b>${fmtTime(landing, true)}</b>.
				Wiosek z ${s.nobles} szlachcicami i eskortą: <b>${rows.length}</b>. ${bbLink}</p>
				<div style="overflow-x:auto"><table class="vis" style="width:100%"><tr><th>Wioska</th>${heads}<th>Pop. offa</th><th>Kareta</th></tr>
				${rows.map(r => `<tr><td><b>${esc(r.v.name)}</b><br><small>${r.v.x}|${r.v.y} · ${r.dist.toFixed(1).replace('.', ',')} pola</small></td>
					${unitCells(r.v, r.off)}<td class="num">${r.pop}</td>${cmdCell(r.cmd, r.v, target, `Kareta (${r.pop} + ${s.nobles} szl.)`)}</tr>`).join('')
					|| `<tr><td colspan="${unitHeads().length + 3}"><small>żadna wioska nie ma ${s.nobles} szlachciców z eskortą (${s.escAxe} Top + ${s.escLight} LK na każdego)</small></td></tr>`}
				</table></div>${foot}
				<p style="margin:2px 0 0 0"><small>Link otwiera Plac z wpisanym offem; szlachciców do karety dodajesz na Placu. Godzina wysyłki liczona tempem szlachcica.</small></p>`);
			tick();
			return;
		}

	}

	// odliczanie: jedna pętla na stronę, tylko wyświetla czas
	function tick() {
		const now = nowMs();
		$(`#${NS}_clock`).text(fmtTime(now));
		$(`#${NS} .pk-cmd`).each(function () {
			const left = Number($(this).data('send')) - now;
			$(this).toggleClass('pk-ok', left > 0);
			$(this).find('.pk-cd').text(fmtLeft(left)).toggleClass('pk-soon', left > 0 && left < 10000).toggleClass('pk-late', left < 0);
		});
	}
	function startClock() {
		if (window[NS + '_timer']) { clearInterval(window[NS + '_timer']); }
		window[NS + '_timer'] = setInterval(() => { if (!$('#' + NS).length) { clearInterval(window[NS + '_timer']); return; } tick(); }, 100);
	}

	// ---------- Start ----------
	async function main() {
		if (typeof game_data === 'undefined') { notify(`${NAME}: uruchom skrypt w grze.`); return; }
		if (!game_data.features || !game_data.features.Premium || !game_data.features.Premium.active) {
			notify(`${NAME}: skrypt korzysta z Przeglądu wojsk, który wymaga Konta Premium.`, 'ErrorMessage'); return;
		}
		const target = readTarget();
		if (!target) { notify(`${NAME}: otwórz stronę informacji o wiosce celu i uruchom skrypt ponownie.`, 'ErrorMessage'); return; }
		const s = loadSettings();
		const [speeds, data] = await Promise.all([unitSpeeds(), loadVillages(s.group)]);
		render({ s, target, speeds, villages: data.villages, groups: data.groups });
	}

	if (Date.now() - (window[NS + '_lastRun'] || 0) < 500) { return; } // gra potrafi wykonać skrót dwa razy naraz
	window[NS + '_lastRun'] = Date.now();
	main().catch(ex => {
		notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'błąd – ' + (ex && ex.message ? ex.message : ex)), 'ErrorMessage');
		console.error(NAME, ex);
	});
})();
