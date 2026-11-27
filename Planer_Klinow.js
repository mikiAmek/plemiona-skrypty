/*
 * Planer Klinów v1.0.0
 * Autor: Mavionis
 *
 * Strona informacji o wiosce celu: uruchom skrypt.
 *
 * Planuje klin na jeden cel: off wchodzi o ustawionej godzinie, a za nim szlachcice co X ms.
 *  - wojska w domu ze wszystkich wiosek wybranej grupy (Przegląd > Wojska, wszystkie strony),
 *  - dokładny zegar gry (milisekundy), czas podróży zaokrąglany do pełnej sekundy jak w grze,
 *  - eskorta każdego szlachcica (domyślnie 20 toporników + 20 LK) odejmowana od offa,
 *  - pełna tabela wszystkich wiosek; na zielono rozkazy, które jeszcze zdążą,
 *  - link otwiera Plac z wpisanymi wojskami – atak klikasz sam,
 *  - rozpiska BB: off i szlachcice z jednej wioski w jednym wierszu.
 * Skrypt niczego nie wysyła ani nie klika. Zapytania: Przegląd wojsk i prędkości jednostek (interface.php) z serwera gry.
 */
(function () {
	'use strict';

	const NAME = 'Planer Klinów';
	const VERSION = 'v1.0.0';
	const NS = 'PlanerKlinow';
	const UNITS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];
	const POP = { spear: 1, sword: 1, axe: 1, archer: 1, spy: 2, light: 4, marcher: 5, heavy: 6, ram: 5, catapult: 8, knight: 10, snob: 100 };
	const LABEL = { spear: 'Pik', sword: 'Miecz', axe: 'Top', archer: 'Łuk', spy: 'Zw', light: 'LK', marcher: 'ŁnK', heavy: 'CK', ram: 'Tar', catapult: 'Kat', knight: 'Ryc', snob: 'Szl' };
	const DEFAULTS = {
		landing: '', gap: 100, nobles: 4, escAxe: 20, escLight: 20, minPop: 0, onlyNobles: false, group: '0',
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
	function fmtLeft(ms) {
		if (ms < 0) { return 'minęło'; }
		const s = Math.floor(ms / 1000);
		return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}.${Math.floor((ms % 1000) / 100)}`;
	}

	function loadSettings() {
		const s = Object.assign({}, DEFAULTS, storageGet('ustawienia') || {});
		s.gap = num(s.gap, DEFAULTS.gap);
		s.nobles = Math.min(num(s.nobles, DEFAULTS.nobles), 10);
		s.escAxe = num(s.escAxe, DEFAULTS.escAxe);
		s.escLight = num(s.escLight, DEFAULTS.escLight);
		s.minPop = num(s.minPop, 0);
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
	const travelMs = (dist, speed) => Math.round(dist * speed * 60) * 1000;   // gra zaokrągla do pełnej sekundy

	function plan(villages, target, s, speeds, landing) {
		return villages.map(v => {
			const u = v.units;
			const dist = Math.hypot(v.x - target.x, v.y - target.y);
			// szlachcice: ilu chcemy, ilu jest i na ilu starczy eskorty
			let k = Math.min(s.nobles, u.snob || 0);
			while (k > 0 && ((u.axe || 0) < k * s.escAxe || (u.light || 0) < k * s.escLight)) { k--; }
			const left = Object.assign({}, u, { axe: (u.axe || 0) - k * s.escAxe, light: (u.light || 0) - k * s.escLight });
			const off = {};
			s.offUnits.forEach(n => { if (n !== 'snob' && left[n] > 0) { off[n] = left[n]; } });
			const offPop = Object.keys(off).reduce((t, n) => t + off[n] * POP[n], 0);
			const offSpeed = Math.max(0, ...Object.keys(off).map(n => speeds[n] || 0));
			const offCmd = offPop > 0 ? { units: off, pop: offPop, land: landing, send: landing - travelMs(dist, offSpeed) } : null;
			const escort = { snob: 1 };
			if (s.escAxe) { escort.axe = s.escAxe; }
			if (s.escLight) { escort.light = s.escLight; }
			const nobleSpeed = Math.max(...Object.keys(escort).map(n => speeds[n] || 0));
			const nobles = [];
			for (let i = 1; i <= k; i++) {
				const land = landing + i * s.gap;
				nobles.push({ units: escort, land, send: land - travelMs(dist, nobleSpeed) });
			}
			return { v, dist, off: offCmd, nobles };
		}).filter(r => (r.off || r.nobles.length) && (!s.onlyNobles || r.nobles.length) && (r.off ? r.off.pop : 0) >= s.minPop)
			.sort((a, b) => Math.min(...[a.off, ...a.nobles].filter(Boolean).map(c => c.send)) - Math.min(...[b.off, ...b.nobles].filter(Boolean).map(c => c.send)));
	}

	// Plac z wpisanymi wojskami (ten sam mechanizm co „Wstaw na plac” w symulatorze) – atak klika gracz
	function placeLink(v, target, units) {
		const t = game_data.player.sitter && Number(game_data.player.sitter) > 0 ? '&t=' + game_data.player.id : '';
		return `/game.php?village=${v.id}${t}&screen=place&target=${target.id}&from=simulator` +
			Object.keys(units).map(n => `&att_${n}=${units[n]}`).join('');
	}

	function bbCode(rows, target, s, landing) {
		const maxN = Math.max(0, ...rows.map(r => r.nobles.length));
		const head = ['Wioska', 'Off – wysyłka', 'Off – populacja'].concat(Array.from({ length: maxN }, (_, i) => `Szlachcic ${i + 1} – wysyłka`));
		const lines = rows.map(r => {
			const cells = [`[coord]${r.v.x}|${r.v.y}[/coord]`, r.off ? fmtTime(r.off.send, true) : '–', r.off ? String(r.off.pop) : '–']
				.concat(Array.from({ length: maxN }, (_, i) => (r.nobles[i] ? fmtTime(r.nobles[i].send, true) : '')));
			return `[*]${cells.join('[|]')}`;
		});
		return `Cel: [coord]${target.x}|${target.y}[/coord] – wejście offa: ${fmtTime(landing, true)}, szlachcice co ${s.gap} ms\n` +
			`[table][**]${head.join('[||]')}[/**]\n${lines.join('\n')}\n[/table]`;
	}

	// ---------- Panel ----------
	function render(state) {
		const { s, target, groups } = state;
		$('#' + NS).remove();
		if (!$('#' + NS + '_css').length) {
			$('head').append(`<style id="${NS}_css">#${NS} label{display:inline;margin:0 6px 0 0;white-space:nowrap}#${NS} input{vertical-align:middle}
				#${NS} small{color:#5a4a2a}#${NS} td.num{text-align:right}#${NS} .pk-ok{background:#c8e6b0}#${NS} .pk-late{color:#999;text-decoration:line-through}
				#${NS} .pk-soon{color:#b00;font-weight:bold}#${NS} .pk-zero{color:#bbb}#${NS} .pk-off{font-weight:bold}</style>`);
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
					<tr><td style="width:170px">Wejście offa</td><td><input type="text" id="${NS}_landing" value="${esc(s.landing)}" placeholder="27.11.2026 20:15:30:000" style="width:190px">
						<small>– czas serwera, dd.mm.rrrr gg:mm:ss:mmm</small></td></tr>
					<tr><td>Szlachcice</td><td>do <input type="text" id="${NS}_nobles" value="${s.nobles}" style="width:25px"> z wioski, co
						<input type="text" id="${NS}_gap" value="${s.gap}" style="width:40px"> ms po offie; eskorta każdego:
						<input type="text" id="${NS}_escaxe" value="${s.escAxe}" style="width:35px"> Top +
						<input type="text" id="${NS}_esclight" value="${s.escLight}" style="width:35px"> LK</td></tr>
					<tr><td>Off z jednostek</td><td>${unitBoxes}</td></tr>
					<tr><td>Wioski</td><td>grupa <select id="${NS}_group">${groupOpts}</select>
						&nbsp; off co najmniej <input type="text" id="${NS}_minpop" value="${s.minPop}" style="width:50px"> populacji
						&nbsp; <label><input type="checkbox" id="${NS}_onlynobles" ${s.onlyNobles ? 'checked' : ''}> tylko wioski ze szlachcicem</label></td></tr>
				</table>
				<div id="${NS}_out" style="margin-top:6px"></div>
			</div>`);
		const read = () => ({
			landing: String($(`#${NS}_landing`).val()).trim(),
			gap: num($(`#${NS}_gap`).val(), DEFAULTS.gap), nobles: Math.min(num($(`#${NS}_nobles`).val(), DEFAULTS.nobles), 10),
			escAxe: num($(`#${NS}_escaxe`).val(), DEFAULTS.escAxe), escLight: num($(`#${NS}_esclight`).val(), DEFAULTS.escLight),
			minPop: num($(`#${NS}_minpop`).val(), 0), onlyNobles: $(`#${NS}_onlynobles`).is(':checked'), group: String($(`#${NS}_group`).val()),
			offUnits: $(`.${NS}_unit:checked`).map(function () { return this.value; }).get()
		});
		$('#' + NS).on('input change', 'input', () => { state.s = read(); storageSet('ustawienia', state.s); draw(state); });
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

	function draw(state) {
		const { s, target, speeds, villages } = state;
		const out = $(`#${NS}_out`);
		const landing = parseLanding(s.landing);
		if (!s.landing) { out.html('<p>Wpisz godzinę wejścia offa.</p>'); return; }
		if (landing === null) { out.html('<p style="color:#b00"><b>Godzina wejścia: wpisz np. 27.11.2026 20:15:30:000</b></p>'); return; }
		const rows = plan(villages, target, s, speeds, landing);
		state.bb = bbCode(rows, target, s, landing);
		const shown = UNITS.filter(n => game_data.units.includes(n) && n !== 'knight');
		const maxN = Math.max(0, ...rows.map(r => r.nobles.length));
		const cmdCell = (r, c, label) => (c
			? `<td class="pk-cmd" data-send="${c.send}"><a href="${placeLink(r.v, target, c.units)}">${label}</a><br><small>${fmtShort(c.send)}</small><br><span class="pk-cd" data-send="${c.send}"></span></td>`
			: '<td></td>');
		const body = rows.map(r => `<tr>
			<td><b>${esc(r.v.name)}</b><br><small>${r.v.x}|${r.v.y} · ${r.dist.toFixed(1).replace('.', ',')} pola</small></td>
			${shown.map(n => {
				const c = r.v.units[n] || 0;
				const inOff = r.off && r.off.units[n];
				return `<td class="num ${c ? (inOff || n === 'snob' ? 'pk-off' : '') : 'pk-zero'}">${c}</td>`;
			}).join('')}
			<td class="num">${r.off ? r.off.pop : '–'}</td>
			${cmdCell(r, r.off, 'Off')}
			${Array.from({ length: maxN }, (_, i) => cmdCell(r, r.nobles[i], `Szlachcic ${i + 1}`)).join('')}
		</tr>`).join('');
		out.html(`
			<p style="margin:0 0 4px 0">Wiosek: <b>${rows.length}</b> z ${villages.length}. Wejście offa: <b>${fmtTime(landing, true)}</b>, szlachcice: ${Array.from({ length: s.nobles }, (_, i) => `+${(i + 1) * s.gap} ms`).join(', ') || 'brak'}.
				<a href="#" id="${NS}_bb">[rozpiska BB]</a></p>
			<div id="${NS}_bbbox" style="display:none;margin:4px 0"><textarea rows="6" style="width:98%" readonly></textarea><br>
				<small>Skopiowane do schowka (jeśli przeglądarka pozwoliła). Off i szlachcice z jednej wioski są w jednym wierszu.</small></div>
			<div style="overflow-x:auto"><table class="vis" style="width:100%">
				<tr><th>Wioska</th>${shown.map(n => `<th><img src="${image_base}unit/unit_${n}.webp" title="${n}" alt="${LABEL[n]}"></th>`).join('')}
					<th>Pop. offa</th><th>Off</th>${Array.from({ length: maxN }, (_, i) => `<th>Szlachcic ${i + 1}</th>`).join('')}</tr>
				${body || `<tr><td colspan="${shown.length + 3}"><small>żadna wioska nie spełnia warunków</small></td></tr>`}
			</table></div>
			<p style="margin:4px 0 0 0"><small>Na zielono: rozkaz jeszcze zdąży. Kliknięcie otwiera Plac z wpisanymi wojskami i celem – atak wysyłasz sam, o godzinie z tabeli.</small></p>`);
		tick();
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
