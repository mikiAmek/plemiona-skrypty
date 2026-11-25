/*
 * Numerator Wiosek v1.3.3
 * Autor: Mavionis
 *
 * Przegląd wiosek: uruchom skrypt. (Na innym ekranie przenosi do Przeglądu > Produkcja ze wszystkimi wioskami.)
 *
 * Skrypt układa nazwy wiosek według numeracji, np. „Wioska 001”:
 *  - bez podziału – wszystkie wioski po kolei: 001, 002, 003…,
 *  - automatycznie według skupisk – wioski leżące blisko siebie tworzą grupę; największa dostaje
 *    numery 001…, następna 101…, kolejna 201…; w grupie numery idą od środka na zewnątrz,
 *  - albo własne strefy – kontynent, odległość od punktu albo prostokąt współrzędnych.
 * Istniejące poprawne numery zostają, nowe wioski dostają pierwszy wolny numer w swojej grupie.
 *
 * Najpierw „Podgląd” (nic się nie zmienia), potem każde kliknięcie „Zmień następną” (albo skrótu)
 * zmienia nazwę JEDNEJ wioski – przyciskiem zmiany nazwy gry. Przed pierwszą zmianą skrypt zapisuje
 * kopię starych nazw, którą można przywrócić. Skrypt nie łączy się z niczym poza serwerem gry.
 */
(function () {
	'use strict';

	const NAME = 'Numerator Wiosek';
	const VERSION = 'v1.3.3';
	const NS = 'NumeratorWiosek';
	const PLAN_TTL = 60 * 60 * 1000;     // plan starszy niż godzina trzeba przeliczyć
	const SAVE_TIMEOUT = 5000;           // ms na potwierdzenie zmiany nazwy przez grę
	const MAX_BACKUPS = 5;               // tyle ostatnich kopii nazw trzymamy
	const LIST_OPEN_MAX = 30;            // dłuższa lista w podglądzie startuje zwinięta i tylko z wioskami do zmiany

	const DEFAULTS = {
		style: 'textnr',     // 'textnr' – tekst + numer; 'nr' – tylko numer; 'same' – ta sama nazwa; 'custom' – własny wzór
		text: 'Wioska',
		pattern: 'Wioska {nr}',
		digits: 3,
		mode: 'islands',     // 'all' – bez podziału; 'islands' – automatycznie według skupisk; 'rules' – własne strefy
		gap: 10,             // wyspy: maks. odległość między sąsiednimi wioskami (pola)
		rules: 'K63 => 101\n* => 1',
		keep: true,          // true – zostaw istniejące numery; false – przenumeruj od nowa
		origin: 'center',    // kolejność numerów: 'center' – od środka serii; 'point' – od wskazanych współrzędnych
		point: ''            // np. '380|560'
	};

	// ---------- Narzędzia ----------
	const notify = (msg, type = 'InfoMessage') => {
		if (typeof UI !== 'undefined' && UI[type]) { UI[type](msg); } else { alert(msg); }
	};
	const storageKey = key => `${NS}_${game_data.player.id}_${key}`;
	const storageGet = key => { try { return JSON.parse(localStorage.getItem(storageKey(key))); } catch (e) { return null; } };
	const storageSet = (key, val) => { try { localStorage.setItem(storageKey(key), JSON.stringify(val)); } catch (e) { /* brak miejsca */ } };
	const storageRemove = key => { try { localStorage.removeItem(storageKey(key)); } catch (e) { /* nic */ } };
	const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
	const continentOf = v => Math.floor(v.y / 100) * 10 + Math.floor(v.x / 100);
	const fmtDate = t => new Date(t).toLocaleString('pl-PL');

	function loadSettings() {
		const s = Object.assign({}, DEFAULTS, storageGet('settings') || {});
		s.digits = Math.min(6, Math.max(1, parseInt(s.digits, 10) || DEFAULTS.digits));
		s.gap = Math.max(1, Number(s.gap) || DEFAULTS.gap);
		if (!['all', 'islands', 'rules'].includes(s.mode)) { s.mode = DEFAULTS.mode; }
		if (!['textnr', 'nr', 'same', 'custom'].includes(s.style)) { s.style = DEFAULTS.style; }
		if (!['center', 'point'].includes(s.origin)) { s.origin = DEFAULTS.origin; }
		return s;
	}

	// ---------- Wioski z bieżącej strony przeglądu ----------
	// Współrzędne zapamiętujemy przy pierwszym odczycie – po zmianie nazwy gra może pokazać w etykiecie
	// samą nową nazwę (bez „(x|y) K..”), a wioska nie może wtedy wypaść z listy.
	// Nazwa wioski z etykiety gry. Po zmianie nazwy gra zapisuje nową nazwę przez jQuery .data('text'),
	// a atrybut data-text w HTML zostaje stary – dlatego najpierw .data(), potem atrybut.
	const labelName = label => String(label.data('text') ?? label.attr('data-text') ?? '').trim();

	const coordCache = window[NS + '_coords'] || (window[NS + '_coords'] = {});

	function readVillages() {
		const list = [];
		$('.quickedit-vn').each(function () {
			const el = $(this);
			const id = Number(el.data('id'));
			const label = el.find('.quickedit-label').first();
			const name = labelName(label);
			const text = label.text();
			// współrzędne wioski stoją na końcu etykiety: „Nazwa (380|560) K53”
			const m = text.match(/\((\d{1,3})\|(\d{1,3})\)\s*K\d+\s*$/) || text.match(/(\d{1,3})\|(\d{1,3})(?!.*\d{1,3}\|\d{1,3})/);
			if (id && m && !coordCache[id]) { coordCache[id] = { x: Number(m[1]), y: Number(m[2]) }; } // współrzędne wioski się nie zmieniają
			const c = coordCache[id];
			if (!id || !c) { return; }
			list.push({ id, name, x: c.x, y: c.y, maxLen: Number(el.data('length')) || 32 });
		});
		return list;
	}

	// ---------- Podział na grupy (wyspy albo strefy) ----------
	// Wyspy: wioski połączone łańcuchem odległości ≤ gap (union-find).
	function islands(villages, gap) {
		const parent = villages.map((_, i) => i);
		const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
		for (let i = 0; i < villages.length; i++) {
			for (let j = i + 1; j < villages.length; j++) {
				if (dist(villages[i], villages[j]) <= gap) { parent[find(i)] = find(j); }
			}
		}
		const map = new Map();
		villages.forEach((v, i) => {
			const r = find(i);
			if (!map.has(r)) { map.set(r, []); }
			map.get(r).push(v);
		});
		return [...map.values()]
			.sort((a, b) => b.length - a.length || Math.min(...a.map(v => v.id)) - Math.min(...b.map(v => v.id)))
			.map(members => {
				const center = { x: members.reduce((t, v) => t + v.x, 0) / members.length, y: members.reduce((t, v) => t + v.y, 0) / members.length };
				return { label: '', start: null, pattern: null, center, members };
			});
	}

	// Serie dla wysp. Przy „zostaw istniejące” wyspa zatrzymuje serię, w której jest większość jej numerów
	// (np. wyspa w K63 z numerami 101–106 zostaje przy 1xx, nawet gdy kiedyś urośnie ponad główną).
	// Pozostałe dostają kolejne wolne serie: największa 001, następna 101, kolejna 201…
	function assignSeries(groups, s) {
		const used = new Set();
		const seriesOf = v => {
			let nr = numberFromName(s.pattern, v.name, v);
			if (nr === null) { const m = v.name.match(/(\d+)\s*$/); nr = m ? parseInt(m[1], 10) : null; }
			// liczby dłuższe niż ustawiona liczba cyfr (np. „5656” przy 3 cyfrach) to nie numery wiosek
			return nr !== null && nr >= 1 && nr < Math.pow(10, s.digits) ? Math.floor((nr - 1) / 100) : null;
		};
		if (s.keep) {
			groups.forEach(g => {
				const votes = new Map();
				g.members.forEach(v => { const k = seriesOf(v); if (k !== null) { votes.set(k, (votes.get(k) || 0) + 1); } });
				const best = [...votes.entries()].filter(([k]) => !used.has(k)).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
				// seria musi mieć poparcie co najmniej połowy wiosek wyspy, inaczej to przypadkowe liczby w nazwach
				if (best && best[1] * 2 >= g.members.length) { g.series = best[0]; used.add(best[0]); }
			});
		}
		let next = 0;
		groups.forEach(g => {
			if (g.series === undefined) { while (used.has(next)) { next++; } g.series = next; used.add(next); }
		});
		groups.sort((a, b) => a.series - b.series);
		groups.forEach((g, i) => { g.start = g.series * 100 + 1; g.label = `Grupa ${i + 1}`; });
		return groups;
	}

	// Strefy: „obszar => numer początkowy [=> wzór]”, sprawdzane od góry
	function parseRules(text) {
		const rules = [];
		String(text || '').split('\n').forEach((raw, n) => {
			const line = raw.trim();
			if (!line || line.startsWith('#')) { return; }
			const parts = line.split('=>').map(p => p.trim());
			if (parts.length < 2) { throw `Strefa ${n + 1}: brakuje numeru początkowego.`; }
			const start = parseInt(parts[1], 10);
			if (!(start >= 0)) { throw `Strefa ${n + 1}: wpisz numer początkowy, np. 1 albo 101.`; }
			const area = parts[0];
			let m, rule;
			if (area === '*') {
				rule = { test: () => true, center: null, desc: 'pozostałe' };
			} else if ((m = area.match(/^K?(\d{1,2})$/i))) {
				const k = Number(m[1]);
				rule = { test: v => continentOf(v) === k, center: null, desc: `K${k}` };
			} else if ((m = area.match(/^(\d{1,3})\|(\d{1,3})\s+(\d+(?:[.,]\d+)?)$/))) {
				const c = { x: Number(m[1]), y: Number(m[2]) }, r = Number(m[3].replace(',', '.'));
				rule = { test: v => dist(v, c) <= r, center: c, desc: `do ${r} pól od ${c.x}|${c.y}` };
			} else if ((m = area.match(/^(\d{1,3})\|(\d{1,3})\s*[-–\s]\s*(\d{1,3})\|(\d{1,3})$/))) {
				const x1 = Math.min(+m[1], +m[3]), x2 = Math.max(+m[1], +m[3]), y1 = Math.min(+m[2], +m[4]), y2 = Math.max(+m[2], +m[4]);
				rule = { test: v => v.x >= x1 && v.x <= x2 && v.y >= y1 && v.y <= y2, center: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, desc: `${x1}|${y1}–${x2}|${y2}` };
			} else {
				throw `Strefa ${n + 1}: uzupełnij obszar – kontynent (np. 63), punkt i promień albo dwa rogi prostokąta (np. 360|540).`;
			}
			rules.push(Object.assign(rule, { start, pattern: parts[2] || null }));
		});
		if (!rules.length) { throw 'Wpisz przynajmniej jedną strefę, np. „* => 1”.'; }
		return rules;
	}

	function zones(villages, rules) {
		const groups = rules.map((r, i) => ({ label: `Strefa ${i + 1} (${r.desc})`, start: r.start, pattern: r.pattern, center: r.center, members: [] }));
		const outside = [];
		villages.forEach(v => {
			const i = rules.findIndex(r => r.test(v));
			if (i < 0) { outside.push(v); } else { groups[i].members.push(v); }
		});
		groups.forEach(g => {
			if (!g.center && g.members.length) {
				g.center = { x: g.members.reduce((t, v) => t + v.x, 0) / g.members.length, y: g.members.reduce((t, v) => t + v.y, 0) / g.members.length };
			}
		});
		return { groups: groups.filter(g => g.members.length), outside };
	}

	// ---------- Nazwy ----------
	function formatName(pattern, nr, v, digits) {
		return pattern
			.replace(/\{nr\}/g, String(nr).padStart(digits, '0'))
			.replace(/\{K\}/g, 'K' + continentOf(v))
			.replace(/\{x\}/g, String(v.x))
			.replace(/\{y\}/g, String(v.y));
	}

	// Numer z obecnej nazwy, jeśli nazwa pasuje do wzoru (np. „Wioska 012” → 12)
	function numberFromName(pattern, name, v) {
		const re = new RegExp('^' + reEsc(pattern)
			.replace(/\\\{nr\\\}/g, '(\\d+)')
			.replace(/\\\{K\\\}/g, 'K' + continentOf(v))
			.replace(/\\\{x\\\}/g, String(v.x))
			.replace(/\\\{y\\\}/g, String(v.y)) + '$');
		const m = name.match(re);
		return m ? parseInt(m[1], 10) : null;
	}

	// Wzór nazwy z rodzaju nazwy wybranego w panelu
	function patternOf(s) {
		const text = String(s.text || '').trim();
		if (s.style === 'nr') { return '{nr}'; }
		if (s.style === 'textnr') { return (text ? text + ' ' : '') + '{nr}'; }
		if (s.style === 'same') { return text; }
		return s.pattern;
	}

	function createPlan(villages, s) {
		const basePattern = patternOf(s);
		if (s.style === 'same') {
			// jedna nazwa dla wszystkich – bez numeracji i podziału na serie
			if (!basePattern) { throw 'Wpisz nazwę dla wszystkich wiosek.'; }
			const rows = villages.map(v => {
				const target = formatName(basePattern, 0, v, s.digits);
				return { id: v.id, x: v.x, y: v.y, group: 0, nr: null, old: v.name, target, tooLong: target.length > v.maxLen, maxLen: v.maxLen };
			});
			return { created: Date.now(), rows, summary: [{ label: `Ta sama nazwa „${basePattern}”`, count: rows.length }], outside: [], warnings: [] };
		}
		s = Object.assign({}, s, { pattern: basePattern });
		if (!/\{nr\}/.test(s.pattern)) { throw 'Wzór nazwy musi zawierać {nr}, np. „Wioska {nr}”.'; }
		let groups, outside = [];
		if (s.mode === 'rules') {
			({ groups, outside } = zones(villages, parseRules(s.rules)));
		} else if (s.mode === 'all') {
			// jedna grupa: wszystkie wioski od 001, od środka całego konta (albo od wskazanego punktu)
			const n = villages.length || 1;
			groups = [{ label: 'Wszystkie wioski', start: 1, members: villages.slice(),
				center: { x: villages.reduce((t, v) => t + v.x, 0) / n, y: villages.reduce((t, v) => t + v.y, 0) / n } }];
		} else {
			groups = assignSeries(islands(villages, s.gap), s);
		}
		let origin = null;
		if (s.origin === 'point') {
			const m = String(s.point || '').match(/(\d{1,3})\|(\d{1,3})/);
			if (!m) { throw 'Wpisz współrzędne punktu, od którego liczyć numery, np. 380|560.'; }
			origin = { x: Number(m[1]), y: Number(m[2]) };
		}
		const rows = [];
		const warnings = [];
		groups.forEach((g, gi) => {
			if (origin) { g.center = origin; } // numery po kolei od wskazanego punktu
			const pattern = g.pattern || s.pattern;
			if (!/\{nr\}/.test(pattern)) { throw `${g.label}: wzór „${pattern}” musi zawierać {nr}.`; }
			const ordered = g.members.slice().sort((a, b) => dist(a, g.center) - dist(b, g.center) || a.id - b.id);
			// zakres serii: do początku następnej serii, a dla ostatniej – setka (albo więcej, gdy wiosek jest ponad 99)
			const width = Math.max(100, Math.ceil(g.members.length / 100) * 100);
			const nextStart = Math.min(g.start + width, groups.filter(o => o !== g && o.start > g.start).reduce((m, o) => Math.min(m, o.start), Infinity));
			const taken = new Set();
			const assigned = new Map();
			if (s.keep) {
				// zostaw poprawne numery z tej serii (bez duplikatów)
				ordered.forEach(v => {
					// numer z nazwy pasującej do wzoru, a gdy zmieniasz format nazwy – numer z końca starej nazwy
					// (np. „Wioska 024” → „024”), żeby numery się nie przesunęły
					let nr = numberFromName(pattern, v.name, v);
					if (nr === null) { const m = v.name.match(/(\d+)\s*$/); nr = m ? parseInt(m[1], 10) : null; }
					if (nr !== null && nr >= g.start && nr < nextStart && !taken.has(nr)) { taken.add(nr); assigned.set(v.id, nr); }
				});
			}
			let nr = g.start;
			ordered.forEach(v => {
				if (assigned.has(v.id)) { return; }
				while (taken.has(nr)) { nr++; }
				taken.add(nr);
				assigned.set(v.id, nr);
			});
			const maxNr = Math.max(...assigned.values());
			if (maxNr >= nextStart) { warnings.push(`${g.label}: numery dochodzą do ${maxNr} i wchodzą na numery następnej grupy (od ${nextStart}) – zmień numery początkowe stref.`); }
			ordered.forEach(v => {
				const n = assigned.get(v.id);
				const target = formatName(pattern, n, v, s.digits);
				rows.push({ id: v.id, x: v.x, y: v.y, group: gi, nr: n, old: v.name, target, tooLong: target.length > v.maxLen, maxLen: v.maxLen });
			});
		});
		// tabela i kolejność zmian: seria po serii, numer po numerze
		rows.sort((a, b) => a.group - b.group || a.nr - b.nr);
		const summary = groups.map((g, gi) => {
			const nrs = rows.filter(r => r.group === gi).map(r => r.nr);
			return { label: g.label, count: g.members.length, from: Math.min(...nrs), to: Math.max(...nrs), center: g.center, fromPoint: !!origin };
		});
		return { created: Date.now(), rows, summary, outside: outside.map(v => ({ id: v.id, name: v.name, x: v.x, y: v.y })), warnings };
	}

	// ---------- Zmiana nazwy jednej wioski (przyciskiem gry) ----------
	const rowsById = () => {
		const map = new Map();
		$('.quickedit-vn').each(function () { map.set(Number($(this).data('id')), $(this)); });
		return map;
	};
	const currentName = el => labelName(el.find('.quickedit-label').first());

	const pendingRows = plan => {
		const dom = rowsById();
		return plan.rows.filter(r => !r.tooLong && dom.has(r.id) && currentName(dom.get(r.id)) !== r.target);
	};

	async function renameNext() {
		const plan = loadPlan();
		if (!plan) { throw 'brak aktualnego planu – kliknij „Podgląd”.'; }
		const pending = pendingRows(plan);
		if (!pending.length) {
			storageRemove('plan');
			renderProgress(plan);
			notify(`${NAME}: gotowe – wszystkie nazwy są zgodne z planem.`, 'SuccessMessage');
			return;
		}
		// kopia starych nazw przed pierwszą zmianą planu
		if (!plan.backupSaved) {
			const backup = { time: Date.now(), names: {} };
			readVillages().forEach(v => { backup.names[v.id] = v.name; });
			const list = loadBackups();
			if (!list.length || JSON.stringify(list[0].names) !== JSON.stringify(backup.names)) {
				list.unshift(backup);
				storageSet('backups', list.slice(0, MAX_BACKUPS));
			}
			plan.backupSaved = true;
			storageSet('plan', plan);
			renderBackupInfo();
		}
		const r = pending[0];
		const el = rowsById().get(r.id);
		el.find('.rename-icon').first().trigger('click');
		const input = el.find('.quickedit-edit input[type=text]').first();
		const button = el.find('.quickedit-edit input[type=button], .quickedit-edit .btn').first();
		if (!input.length || !button.length) { throw 'nie znalazłem pola zmiany nazwy gry – odśwież stronę.'; }
		input.val(r.target);
		button.trigger('click');
		// czekamy, aż gra potwierdzi nową nazwę
		const t0 = Date.now();
		while (Date.now() - t0 < SAVE_TIMEOUT) {
			await new Promise(res => setTimeout(res, 150));
			if (currentName(rowsById().get(r.id)) === r.target) {
				const left = pendingRows(plan).length;
				renderProgress(plan);
				notify(`${NAME}: ${r.old} → ${r.target} (zostało: ${left}).`, 'SuccessMessage');
				return;
			}
		}
		renderProgress(plan);
		throw `gra nie potwierdziła zmiany nazwy „${r.old}” w ${SAVE_TIMEOUT / 1000} s – sprawdź wiersz i kliknij jeszcze raz.`;
	}

	async function runStep() {
		if (window[NS + '_busy']) { return; }
		window[NS + '_busy'] = true;
		try { await renameNext(); }
		catch (ex) { notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'nie udało się zmienić nazwy.'), 'ErrorMessage'); console.error(NAME, ex); }
		finally { window[NS + '_busy'] = false; }
	}

	const loadBackups = () => {
		const list = storageGet('backups');
		return Array.isArray(list) ? list.filter(b => b && b.names) : [];
	};

	const loadPlan = () => {
		const p = storageGet('plan');
		return p && Date.now() - p.created < PLAN_TTL ? p : null;
	};

	// ---------- Edytor stref (tabela) <-> zapis tekstowy reguł ----------
	// Strefy trzymamy w ustawieniach jako tekst „obszar => numer [=> wzór]” (ten sam format czyta parseRules),
	// a w panelu pokazujemy je jako tabelę z polami.
	function rulesToZones(text) {
		const out = [];
		String(text || '').split('\n').forEach(raw => {
			const parts = raw.split('=>').map(p => p.trim());
			if (parts.length < 2 || !parts[0]) { return; }
			const area = parts[0], z = { start: parts[1], pattern: parts[2] || '' };
			const val = v => (v === '?' ? '' : v);
			let m;
			if (area === '*') { z.type = '*'; }
			else if ((m = area.match(/^K?(\d{0,2})$/i))) { z.type = 'K'; z.k = m[1]; }
			else if ((m = area.match(/^(\S*)\s+(\S*)$/)) && !/-/.test(area)) { z.type = 'R'; z.pt = val(m[1]); z.r = val(m[2]); }
			else if ((m = area.match(/^(\S*)\s*[-–]\s*(\S*)$/))) { z.type = 'P'; z.p1 = val(m[1]); z.p2 = val(m[2]); }
			else { return; }
			out.push(z);
		});
		return out.length ? out : [{ type: '*', start: 1, pattern: '' }];
	}

	function zoneRowHtml(z) {
		const opt = (v, t) => `<option value="${v}" ${z.type === v ? 'selected' : ''}>${t}</option>`;
		const inp = (cls, val, w, ph) => `<input type="text" class="${cls}" value="${esc(val ?? '')}" placeholder="${ph}" style="width:${w}px">`;
		const where = {
			K: `K ${inp('nw-k', z.k, 30, '63')}`,
			R: `do ${inp('nw-r', z.r, 30, '15')} pól od ${inp('nw-pt', z.pt, 60, 'x|y')}`,
			P: `od ${inp('nw-p1', z.p1, 60, 'x|y')} do ${inp('nw-p2', z.p2, 60, 'x|y')}`,
			'*': '<small>wioski, które nie pasują do stref wyżej</small>'
		}[z.type];
		return `<tr class="nw-zone"><td class="nw-no"></td>
			<td><select class="nw-type">${opt('K', 'Kontynent')}${opt('R', 'Odległość od punktu')}${opt('P', 'Prostokąt')}${opt('*', 'Wszystkie pozostałe')}</select></td>
			<td style="white-space:nowrap">${where}</td>
			<td>${inp('nw-start', z.start, 45, '1')}</td>
			<td title="Puste = nazwa z „Rodzaj nazwy” wyżej. Wpisz np. OFF {nr}, żeby wioski z tej strefy miały inną nazwę.">${inp('nw-pat', z.pattern, 95, 'np. OFF {nr}')}</td>
			<td style="white-space:nowrap"><a href="#" class="nw-up" title="wyżej">▲</a> <a href="#" class="nw-down" title="niżej">▼</a> <a href="#" class="nw-del" title="usuń">✕</a></td></tr>`;
	}

	function readZoneRow(tr) {
		const v = cls => String(tr.find('.' + cls).val() ?? '').trim();
		return { type: tr.find('.nw-type').val(), k: v('nw-k'), r: v('nw-r'), pt: v('nw-pt'), p1: v('nw-p1'), p2: v('nw-p2'), start: v('nw-start'), pattern: v('nw-pat') };
	}

	const readZones = () => $(`#${NS}_zones tr.nw-zone`).map(function () { return readZoneRow($(this)); }).get();

	const renumberZones = () => $(`#${NS}_zones tr.nw-zone .nw-no`).each(function (i) { $(this).text(i + 1); });

	function zonesToRules(list) {
		return list.map(z => {
			// puste pola zapisujemy jako „?”, żeby niedokończona strefa nie zmieniła typu po ponownym otwarciu
			const f = v => v || '?';
			const area = { K: 'K' + z.k, R: `${f(z.pt)} ${f(z.r)}`, P: `${f(z.p1)}-${f(z.p2)}`, '*': '*' }[z.type];
			return `${area} => ${z.start}` + (z.pattern ? ` => ${z.pattern}` : '');
		}).join('\n');
	}

	// pole „Tekst” przyciemnione, gdy wybrany rodzaj nazwy go nie używa (Tylko numer, Własny wzór)
	function nameFields() {
		const style = $(`input[name=${NS}_style]:checked`).val();
		$(`#${NS}_textrow`).css('opacity', style === 'nr' || style === 'custom' ? 0.45 : 1);
	}

	// ---------- Panel ----------
	function readPanel() {
		const s = loadSettings();
		s.style = $(`input[name=${NS}_style]:checked`).val() || DEFAULTS.style;
		s.text = String($(`#${NS}_text`).val() ?? s.text).trim();
		s.pattern = String($(`#${NS}_pattern`).val() ?? s.pattern).trim() || DEFAULTS.pattern;
		s.digits = Math.min(6, Math.max(1, parseInt($(`#${NS}_digits`).val(), 10) || DEFAULTS.digits));
		s.mode = $(`input[name=${NS}_mode]:checked`).val() || 'islands';
		s.gap = Math.max(1, Number(String($(`#${NS}_gap`).val() ?? '').replace(',', '.')) || DEFAULTS.gap);
		if ($(`#${NS}_zones`).length) { s.rules = zonesToRules(readZones()); }
		s.keep = $(`input[name=${NS}_keep]:checked`).val() !== 'renumber';
		s.origin = $(`input[name=${NS}_origin]:checked`).val() || 'center';
		s.point = String($(`#${NS}_point`).val() ?? '').trim();
		return s;
	}

	function renderPanel(s) {
		if (!$('#' + NS + '_style').length) {
			$('head').append(`<style id="${NS}_style">#${NS} label{display:inline;margin:0;white-space:nowrap}
				#${NS} input[type=radio]{vertical-align:middle;margin:0 3px 0 0}#${NS} input[type=text]{vertical-align:middle}
				#${NS} .nw-opt{margin:0 0 6px 0;line-height:22px}#${NS} small{color:#5a4a2a}</style>`);
		}
		$($('#content_value').length ? '#content_value' : '#mobileContent').first().prepend(`
			<div id="${NS}" class="vis" style="padding:8px;margin-bottom:10px">
				<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small></h3>
				<table class="vis" style="width:100%">
					<tr><th colspan="2">Nazwy</th></tr>
					<tr><td style="width:120px;vertical-align:top">Rodzaj nazwy</td><td>
						<div class="nw-opt"><label><input type="radio" name="${NS}_style" value="textnr" ${s.style === 'textnr' ? 'checked' : ''}> <b>Tekst + numer</b></label> – np. Wioska 001, Wioska 002…</div>
						<div class="nw-opt"><label><input type="radio" name="${NS}_style" value="nr" ${s.style === 'nr' ? 'checked' : ''}> <b>Tylko numer</b></label> – np. 001, 002…</div>
						<div class="nw-opt"><label><input type="radio" name="${NS}_style" value="same" ${s.style === 'same' ? 'checked' : ''}> <b>Ta sama nazwa dla wszystkich</b></label> – bez numerów</div>
						<div class="nw-opt"><label><input type="radio" name="${NS}_style" value="custom" ${s.style === 'custom' ? 'checked' : ''}> <b>Własny wzór</b></label>
							<input type="text" id="${NS}_pattern" value="${esc(s.pattern)}" style="width:180px">
							<br><small>w nawiasy { } skrypt wstawia dane wioski: {nr} numer, {K} kontynent, {x} {y} współrzędne<br>
								np. „{nr} {K}” → 001 K53, „OFF {nr}” → OFF 001, „{nr} ({x}|{y})” → 001 (380|560); nazwa maks. 32 znaki</small></div></td></tr>
					<tr id="${NS}_textrow"><td>Tekst</td><td><input type="text" id="${NS}_text" value="${esc(s.text)}" style="width:150px">
						<small>– do „Tekst + numer” i „Ta sama nazwa dla wszystkich”</small></td></tr>
					<tr><td>Cyfr numeru</td><td><input type="text" id="${NS}_digits" value="${s.digits}" style="width:30px">
						<small>– 3 → 001, 002…; 2 → 01, 02…; 1 → 1, 2…</small></td></tr>
					<tr><th colspan="2">Grupy wiosek <small style="font-weight:normal">– wioski w różnych miejscach mogą mieć osobne numery, np. 001… i 101…</small></th></tr>
					<tr><td style="vertical-align:top">Podział</td><td>
						<div class="nw-opt"><label><input type="radio" name="${NS}_mode" value="all" ${s.mode === 'all' ? 'checked' : ''}> <b>Bez podziału</b></label> – wszystkie wioski po kolei: 001, 002, 003…</div>
						<div class="nw-opt"><label><input type="radio" name="${NS}_mode" value="islands" ${s.mode === 'islands' ? 'checked' : ''}> <b>Automatycznie według skupisk</b></label>
							– wioski, między którymi jest najwyżej <input type="text" id="${NS}_gap" value="${s.gap}" style="width:35px"> pól, to jedna grupa
							<br><small>największa grupa dostaje 001…, następna 101…, kolejna 201…; grupa z nadanymi już numerami zostaje przy swojej setce</small></div>
						<div class="nw-opt"><label><input type="radio" name="${NS}_mode" value="rules" ${s.mode === 'rules' ? 'checked' : ''}> <b>Własne strefy</b></label>
							<small>– sam wybierasz obszary i numer początkowy; wioska trafia do pierwszej pasującej strefy (od góry), „Wszystkie pozostałe” zostaw na końcu</small>
							<div style="overflow-x:auto"><table class="vis" id="${NS}_zones" style="width:100%;margin-top:3px">
								<tr><th>#</th><th>Obszar</th><th>Gdzie</th><th>Od numeru</th><th>Inna nazwa w tej strefie <small>(opcjonalnie)</small></th><th></th></tr>
								${rulesToZones(s.rules).map(zoneRowHtml).join('')}
							</table></div>
							<a href="#" id="${NS}_addzone">+ dodaj strefę</a></div>
					</td></tr>
					<tr><td style="vertical-align:top">Kolejność</td><td>
						<div class="nw-opt"><label><input type="radio" name="${NS}_origin" value="center" ${s.origin === 'center' ? 'checked' : ''}> od środka grupy / strefy</label></div>
						<div class="nw-opt"><label><input type="radio" name="${NS}_origin" value="point" ${s.origin === 'point' ? 'checked' : ''}> od współrzędnych</label>
							<input type="text" id="${NS}_point" value="${esc(s.point || (game_data.village.x + '|' + game_data.village.y))}" style="width:70px">
							<small>– najbliższa wioska dostaje pierwszy numer w grupie, dalej coraz dalsze</small></div>
					</td></tr>
					<tr><th colspan="2">Obecne nazwy wiosek</th></tr>
					<tr><td colspan="2">
						<div class="nw-opt"><label><input type="radio" name="${NS}_keep" value="keep" ${s.keep ? 'checked' : ''}> <b>Zostaw obecne numery</b></label>
							<br><small>zmieniają się tylko nowe wioski i te bez numeru – dostają pierwszy wolny numer w swojej grupie (nie zawsze zgodny z kolejnością)</small></div>
						<div class="nw-opt"><label><input type="radio" name="${NS}_keep" value="renumber" ${s.keep ? '' : 'checked'}> <b>Zmień wszystko od nowa</b></label>
							<br><small>numery ściśle według kolejności wyżej – nowa wioska wchodzi na swoje miejsce, a dalsze przesuwają się o jeden</small>
							<div id="${NS}_keepwarn" class="nw-warn" style="display:none;color:#b00;font-weight:bold">⚠ To może zmienić nazwy wielu wiosek. Sprawdź w Podglądzie, ile jest „Do zmiany”.</div></div>
					</td></tr>
				</table>
				<div style="margin-top:6px">
					<input type="button" class="btn" id="${NS}_preview" value="Podgląd">
					<input type="button" class="btn" id="${NS}_next" value="Zmień następną">
					<input type="button" class="btn" id="${NS}_restore" value="Przywróć nazwy z kopii">
					<span id="${NS}_progress" style="margin-left:8px"></span>
				</div>
				<div id="${NS}_backup" style="margin-top:4px"></div>
				<div id="${NS}_plan" style="margin-top:6px"></div>
			</div>`);
		$('#' + NS).on('input change', 'input, textarea', () => storageSet('settings', readPanel()));
		$('#' + NS).on('focus input', `#${NS}_pattern`, () => { $(`input[name=${NS}_style][value=custom]`).prop('checked', true); nameFields(); });
		$('#' + NS).on('change', `input[name=${NS}_style]`, nameFields);
		const keepWarn = () => $(`#${NS}_keepwarn`).toggle($(`input[name=${NS}_keep]:checked`).val() === 'renumber');
		$('#' + NS).on('change', `input[name=${NS}_keep]`, keepWarn);
		keepWarn();
		nameFields();
		$('#' + NS).on('focus input', `#${NS}_point`, () => $(`input[name=${NS}_origin][value=point]`).prop('checked', true));
		$('#' + NS).on('focus input', `#${NS}_gap`, () => $(`input[name=${NS}_mode][value=islands]`).prop('checked', true));
		// edytor stref: każda zmiana w tabeli włącza „Własne strefy”
		const zonesChanged = () => { $(`input[name=${NS}_mode][value=rules]`).prop('checked', true); renumberZones(); storageSet('settings', readPanel()); };
		$('#' + NS).on('focus', `#${NS}_zones input, #${NS}_zones select`, () => $(`input[name=${NS}_mode][value=rules]`).prop('checked', true));
		$('#' + NS).on('change', `#${NS}_zones select`, function () {
			const tr = $(this).closest('tr');
			tr.replaceWith(zoneRowHtml(Object.assign(readZoneRow(tr), { type: $(this).val() })));
			zonesChanged();
		});
		$('#' + NS).on('click', `#${NS}_addzone`, e => {
			e.preventDefault();
			const rows = $(`#${NS}_zones tr.nw-zone`);
			const last = rows.last();
			const zone = { type: 'R', pt: '', r: 15, start: rows.length * 100 + 1, pattern: '' };
			// nowa strefa przed „Wszystkie pozostałe”, żeby tamta została na końcu
			if (last.length && readZoneRow(last).type === '*') { last.before(zoneRowHtml(zone)); } else { $(`#${NS}_zones`).append(zoneRowHtml(zone)); }
			zonesChanged();
		});
		$('#' + NS).on('click', `#${NS}_zones .nw-up, #${NS}_zones .nw-down, #${NS}_zones .nw-del`, function (e) {
			e.preventDefault();
			const tr = $(this).closest('tr');
			if ($(this).hasClass('nw-up')) { tr.prev('tr.nw-zone').before(tr); }
			else if ($(this).hasClass('nw-down')) { tr.next('tr.nw-zone').after(tr); }
			else { tr.remove(); }
			zonesChanged();
		});
		$('#' + NS).on('click', `#${NS}_preview`, () => {
			try {
				const plan = createPlan(readVillages(), readPanel());
				storageSet('plan', plan);
				renderPlan(plan);
			} catch (ex) {
				$(`#${NS}_plan`).empty();
				notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'błąd obliczeń.'), 'ErrorMessage');
				console.error(NAME, ex);
			}
		});
		$('#' + NS).on('click', `#${NS}_next`, runStep);
		$('#' + NS).on('click', `#${NS}_restore`, () => {
			const backup = loadBackups()[Number($(`#${NS}_backupsel`).val()) || 0];
			if (!backup) { notify(`${NAME}: brak kopii – powstaje przy pierwszej zmianie nazwy.`, 'ErrorMessage'); return; }
			const villages = readVillages();
			const rows = villages.filter(v => backup.names[v.id] !== undefined)
				.map(v => ({ id: v.id, x: v.x, y: v.y, group: 0, nr: null, old: v.name, target: backup.names[v.id], tooLong: false, maxLen: v.maxLen }));
			const plan = { created: Date.now(), rows, summary: [{ label: `Kopia z ${fmtDate(backup.time)}`, count: rows.length }], outside: [], warnings: [], restore: true, backupSaved: true };
			storageSet('plan', plan);
			renderPlan(plan);
		});
		renumberZones();
		renderBackupInfo();
	}

	function renderBackupInfo() {
		const list = loadBackups();
		$(`#${NS}_backup`).html(list.length
			? `<small>Kopia starych nazw do przywrócenia: <select id="${NS}_backupsel">${list.map((b, i) =>
				`<option value="${i}">${fmtDate(b.time)} (${Object.keys(b.names).length} wiosek)</option>`).join('')}</select>
				– <a href="#" id="${NS}_showbackup">pokaż</a></small><div id="${NS}_backuptext"></div>`
			: '<small>Kopia starych nazw powstanie automatycznie przy pierwszej zmianie.</small>');
		$(`#${NS}_showbackup`).on('click', e => {
			e.preventDefault();
			const backup = list[Number($(`#${NS}_backupsel`).val()) || 0];
			$(`#${NS}_backuptext`).html(`<textarea rows="3" style="width:95%" readonly>${esc(JSON.stringify(backup))}</textarea>
				<br><small>Skopiuj i zachowaj u siebie (np. w Notatkach) – na wypadek wyczyszczenia przeglądarki.</small>`);
		});
	}

	function renderPlan(plan) {
		const pending = pendingRows(plan);
		const pendingIds = new Set(pending.map(r => r.id));
		const summary = plan.summary.map(g => g.from !== undefined
			? `<li><b>${esc(g.label)}</b>: ${g.count} wiosek, numery ${g.from}–${g.to}${g.center ? `, ${g.fromPoint ? 'liczone od' : 'środek ok.'} ${Math.round(g.center.x)}|${Math.round(g.center.y)}` : ''}</li>`
			: `<li><b>${esc(g.label)}</b>: ${g.count} wiosek</li>`).join('');
		const rows = plan.rows.map(r => `<tr${pendingIds.has(r.id) ? '' : ' class="nw-same" style="opacity:.55"'}>
			<td>${r.x}|${r.y}</td><td>${esc(r.old)}</td><td><b>${esc(r.target)}</b></td>
			<td>${r.tooLong ? `<span style="color:#b00">za długa (maks. ${r.maxLen})</span>` : pendingIds.has(r.id) ? 'do zmiany' : 'bez zmian'}</td></tr>`).join('');
		$(`#${NS}_plan`).html(`
			<ul style="margin:4px 0 4px 18px;padding:0">${summary}</ul>
			${plan.outside.length ? `<p><small>Poza strefami (bez zmian): ${plan.outside.map(v => esc(v.name)).join(', ')}</small></p>` : ''}
			${plan.warnings.map(w => `<p style="color:#b00"><b>Uwaga:</b> ${esc(w)}</p>`).join('')}
			<p>Do zmiany: <b>${pending.length}</b> z ${plan.rows.length}. Każde kliknięcie „Zmień następną” (albo skrótu) zmienia jedną wioskę.</p>
			<details id="${NS}_list" ${plan.rows.length <= LIST_OPEN_MAX ? 'open' : ''}>
				<summary style="cursor:pointer"><b>Lista wiosek</b> (${plan.rows.length}) – pokaż / ukryj</summary>
				<label style="display:block;margin:4px 0"><input type="checkbox" id="${NS}_onlychanged" ${plan.rows.length > LIST_OPEN_MAX ? 'checked' : ''}> pokaż tylko do zmiany</label>
				<div style="max-height:320px;overflow:auto"><table class="vis" style="width:100%" id="${NS}_listtable">
					<tr><th>Wioska</th><th>Obecna nazwa</th><th>Nowa nazwa</th><th>Stan</th></tr>${rows}</table></div>
			</details>`);
		const filter = () => $(`#${NS}_listtable tr.nw-same`).toggle(!$(`#${NS}_onlychanged`).is(':checked'));
		$(`#${NS}_onlychanged`).on('change', filter);
		filter();
		renderProgress(plan);
	}

	function renderProgress(plan) {
		const left = pendingRows(plan).length;
		$(`#${NS}_progress`).html(left ? `Zostało: <b>${left}</b> z ${plan.rows.length}` : '<b>Wszystkie nazwy zgodne z planem.</b>');
	}

	// ---------- Start ----------
	try {
		if (Date.now() - (window[NS + '_lastRun'] || 0) < 500) { return; } // gra potrafi wykonać skrót dwa razy naraz
		window[NS + '_lastRun'] = Date.now();
		if (typeof game_data === 'undefined') { notify(`${NAME}: uruchom skrypt w grze.`); return; }

		const url = location.href;
		const onOverview = /[?&]screen=overview_villages(&|$)/.test(url) && $('.quickedit-vn').length > 0;
		if (!onOverview || !/[?&]page=-1(&|$)/.test(url)) {
			const t = game_data.player.sitter && Number(game_data.player.sitter) > 0 ? '&t=' + game_data.player.id : '';
			const group = (url.match(/[?&]group=(\d+)/) || [])[1];
			location.href = `/game.php?village=${game_data.village.id}${t}&screen=overview_villages&mode=prod&page=-1${group ? '&group=' + group : ''}`;
			return;
		}
		if ($('#' + NS).length) {
			// panel jest otwarty – skrót działa jak „Zmień następną”
			if (loadPlan()) { runStep(); } else { notify(`${NAME}: kliknij „Podgląd”.`); }
			return;
		}
		renderPanel(loadSettings());
		const plan = loadPlan();
		if (plan) { renderPlan(plan); }
	} catch (ex) {
		notify(NAME + ' ' + VERSION + ': błąd – ' + (ex && ex.message ? ex.message : ex), 'ErrorMessage');
		console.error(NAME, ex);
	}
})();
