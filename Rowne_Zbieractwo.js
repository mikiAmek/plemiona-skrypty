/*
 * Równe Zbieractwo v2.1.0
 * Autor: Mavionis
 *
 * Plac > Zbieractwo masowe: uruchom skrypt. Pojawi się panel z ustawieniami.
 * (Uruchomiony na innym ekranie – przenosi do Zbieractwa masowego.)
 *
 * Zaznaczasz jednostki, a skrypt sam dobiera wspólny zestaw wojsk dla wiosek z aktywnej grupy (wszystkie strony)
 * i dzieli go na poziomy tak, żeby wszystkie oddziały wróciły o tej samej godzinie.
 * Każde kliknięcie skrótu (albo „Następny krok”) = jedna akcja: wpisuje zestaw kolejnego poziomu w formularz gry
 * i zaznacza jego kolumnę (gra sama zaznacza tylko wioski, które mają tyle wojsk) albo przechodzi na następną stronę.
 * Wysyłasz SAM przyciskiem „Wyślij” gry.
 *
 * Skrypt niczego nie wysyła, nie klika i nie ustawia kursora na przycisku „Wyślij”.
 * Wymaga Konta Premium (Zbieractwo masowe to funkcja premium).
 * Ustawienia z panelu są zapamiętywane w przeglądarce (localStorage), osobno dla każdego konta.
 * Skrypt nie używa ciasteczek i nie łączy się z żadnymi stronami poza serwerem gry.
 */

(function () {
	'use strict';

	const notify = (msg, type, ms) => {
		if (typeof UI !== 'undefined' && UI[type || 'ErrorMessage']) { UI[type || 'ErrorMessage'](msg, ms || 8000); }
		else { alert(String(msg).replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')); }
	};
	if (typeof game_data === 'undefined' || typeof jQuery === 'undefined') {
		notify('Równe Zbieractwo: uruchom skrypt na stronie gry Plemiona (wersja na komputer).');
		return;
	}

	const NAME = 'Równe Zbieractwo';
	const VERSION = 'v2.3.0';
	const NS = 'RowneZbieractwo';
	const MIN_POP = 10;                 // gra przyjmuje oddział od 10 populacji
	const PLAN_TTL = 30 * 60 * 1000;    // plan starszy niż 30 min trzeba przeliczyć
	const SCAV_UNITS = ['spear', 'sword', 'axe', 'archer', 'light', 'marcher', 'heavy', 'knight'];
	const UNIT_NAMES = {
		spear: 'Pikinier', sword: 'Miecznik', axe: 'Topornik', archer: 'Łucznik',
		light: 'Lekki kawalerzysta', marcher: 'Łucznik na koniu', heavy: 'Ciężki kawalerzysta', knight: 'Rycerz'
	};

	const DEFAULTS = {
		units: { spear: false, sword: false, axe: false, archer: false, light: true, marcher: false, heavy: false, knight: false },
		reserve: { spear: 0, sword: 0, axe: 0, archer: 0, light: 0, marcher: 0, heavy: 0, knight: 0 },
		levels: [true, true, true, true],
		mode: 'best',      // 'best' – najwięcej łupu na godzinę; 'time' – powrót po zadanym czasie
		hours: 2
	};

	// ---------- Pomocnicze ----------

	const fmt = n => Math.round(n).toLocaleString('pl-PL');
	const fmtTime = s => {
		s = Math.round(s);
		return Math.floor(s / 3600) + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
	};
	const sitterParam = () =>
		(game_data.player.sitter && game_data.player.sitter !== '0') ? '&t=' + game_data.player.id : '';

	const storageKey = key => NS + '_' + game_data.player.id + '_' + key;
	function storageGet(key) {
		try { return JSON.parse(localStorage.getItem(storageKey(key))); } catch (e) { return null; }
	}
	function storageSet(key, value) {
		try { localStorage.setItem(storageKey(key), JSON.stringify(value)); } catch (e) { /* brak dostępu */ }
	}
	function storageRemove(key) {
		try { localStorage.removeItem(storageKey(key)); } catch (e) { /* brak dostępu */ }
	}

	function loadSettings() {
		const s = JSON.parse(JSON.stringify(DEFAULTS));
		const saved = storageGet('settings2') || {};
		for (const u of SCAV_UNITS) {
			if (saved.units && typeof saved.units[u] === 'boolean') { s.units[u] = saved.units[u]; }
			if (saved.reserve && Number.isFinite(saved.reserve[u])) { s.reserve[u] = Math.max(0, saved.reserve[u]); }
		}
		if (Array.isArray(saved.levels) && saved.levels.length === 4) { s.levels = saved.levels.map(Boolean); }
		if (saved.mode === 'time' || saved.mode === 'best') { s.mode = saved.mode; }
		if (Number.isFinite(saved.hours) && saved.hours > 0) { s.hours = saved.hours; }
		return s;
	}

	// ---------- Dane z gry (tylko odczyt) ----------

	// Odczytuje jedną wartość JSON (obiekt, tablicę lub liczbę) z tekstu, zaczynając od pozycji i.
	function readJsonValue(text, i) {
		while (/[\s,]/.test(text[i])) { i++; }
		const start = i;
		if (text[i] === '{' || text[i] === '[') {
			let depth = 0;
			let inString = false;
			for (; i < text.length; i++) {
				const c = text[i];
				if (inString) {
					if (c === '\\') { i++; } else if (c === '"') { inString = false; }
				} else if (c === '"') { inString = true; }
				else if (c === '{' || c === '[') { depth++; }
				else if (c === '}' || c === ']') { depth--; if (depth === 0) { i++; break; } }
			}
			return { value: JSON.parse(text.slice(start, i)), end: i };
		}
		const m = /^-?\d+(\.\d+)?/.exec(text.slice(i));
		if (!m) { throw 'Nieoczekiwany format danych zbieractwa.'; }
		return { value: Number(m[0]), end: i + m[0].length };
	}

	// Strona przekazuje dane do gry jako argumenty new ScavengeMassScreen(poziomy, jednostki, liczba, wioski, ...)
	function parseMassPage(html) {
		const at = html.indexOf('new ScavengeMassScreen(');
		if (at === -1) { throw 'Nie znaleziono danych Zbieractwa masowego.'; }
		let pos = at + 'new ScavengeMassScreen('.length;
		const options = readJsonValue(html, pos); pos = options.end;
		const units = readJsonValue(html, pos); pos = units.end;
		const third = readJsonValue(html, pos); pos = third.end;
		const villages = readJsonValue(html, pos);
		if (!Array.isArray(villages.value)) { throw 'Nieoczekiwany format listy wiosek zbieractwa.'; }
		return { options: options.value, units: units.value, villages: villages.value };
	}

	const currentPage = () => Number((/[?&]page=(\d+)/.exec(location.href) || [])[1] || 0);
	const pageUrl = page => '/game.php?village=' + game_data.village.id + '&screen=place&mode=scavenge_mass&page=' + page + sitterParam();

	// Aktualne wojska wszystkich wiosek aktywnej grupy – wszystkie strony listy (tylko odczyt)
	async function fetchAllPages() {
		let options = null;
		let units = null;
		const villages = [];
		const seen = new Set();
		let pages = 0;
		for (let page = 0; page < 40; page++) {
			const html = await $.get(pageUrl(page));
			const data = parseMassPage(html);
			options = options || data.options;
			units = units || data.units;
			// strona bez nowych wiosek = koniec listy (zabezpieczenie przed czytaniem w kółko tej samej strony)
			const fresh = data.villages.filter(v => !seen.has(v.village_id));
			if (!fresh.length) { break; }
			fresh.forEach(v => { seen.add(v.village_id); v._page = page; });
			villages.push(...fresh);
			pages = page + 1;
			if (!/rel="next"/.test(html)) { break; }
		}
		return { options, units, villages, pages };
	}

	// ---------- Obliczenia ----------

	// Czas zbieractwa (s) dla łupu `haul` – wzór gry, parametry z danych poziomu
	const duration = (opt, haul) =>
		(Math.pow(haul * haul * 100, opt.duration_exponent) + opt.duration_initial_seconds) * opt.duration_factor;
	// Łup, przy którym zbieractwo trwa dokładnie `seconds`
	const haulForDuration = (opt, seconds) => {
		const base = seconds / opt.duration_factor - opt.duration_initial_seconds;
		return base > 0 ? Math.sqrt(Math.pow(base, 1 / opt.duration_exponent) / 100) : 0;
	};

	// Plan: wspólny zestaw na każdy poziom (te same liczby dla wszystkich wiosek – tak działa formularz gry).
	// Każdy poziom dostaje tę samą mieszankę w proporcji 1/łup poziomu, więc wszystkie oddziały wracają razem.
	function createPlan(data, settings) {
		const unitIds = SCAV_UNITS.filter(u => settings.units[u] && data.units[u] && data.units[u].carry > 0);
		if (!unitIds.length) { throw 'Zaznacz co najmniej jedną jednostkę.'; }
		const levels = [1, 2, 3, 4].filter(id => settings.levels[id - 1] && data.options[id]);
		if (!levels.length) { throw 'Zaznacz co najmniej jeden poziom.'; }

		const villages = data.villages.filter(v => v.has_rally_point).map(v => {
			const avail = {};
			for (const u of unitIds) { avail[u] = Math.max(0, (v.unit_counts_home[u] || 0) - (settings.reserve[u] || 0)); }
			const free = levels.filter(id => {
				const st = v.options[id];
				return st && !st.is_locked && !st.unlock_time && !st.scavenging_squad;
			});
			return { v, avail, free };
		});
		const active = villages.filter(x => x.free.length && unitIds.some(u => x.avail[u] > 0));
		if (!active.length) { throw 'W tej grupie żadna wioska nie ma wolnego poziomu i wojsk do wysłania.'; }

		const carryOf = (t, units) => units.reduce((a, u) => a + (t[u] || 0) * data.units[u].carry, 0);
		const popOf = (t, units) => units.reduce((a, u) => a + (t[u] || 0) * data.units[u].pop, 0);

		// Kandydaci na mieszankę: percentyle liczby jednostek w wioskach (od słabszych do najsilniejszej).
		// Mediana bywa za mała, gdy wiosek jest mało albo są bardzo różne – wybór robi symulacja.
		const pct = (arr, q) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))]; };
		const mixes = [];
		for (const q of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
			const m = {};
			for (const u of unitIds) { m[u] = pct(active.map(x => x.avail[u]), q); }
			const key = unitIds.map(u => m[u]).join(',');
			if (unitIds.some(u => m[u] > 0) && !mixes.some(x => x.key === key)) { mixes.push({ m, key }); }
		}

		// Kandydaci na poziomy: każdy niepusty podzbiór zaznaczonych (przy małych wojskach lepiej pominąć któryś poziom)
		// tylko poziomy odblokowane i wolne w co najmniej jednej wiosce, która ma co wysłać
		const usable = levels.filter(id => active.some(x => x.free.includes(id)));
		const subsets = [];
		for (let mask = 1; mask < (1 << usable.length); mask++) { subsets.push(usable.filter((_, i) => mask & (1 << i))); }

		// Symulacja tego, co zrobi gra: poziom po poziomie, wioska wysyła zestaw, jeśli ma go w całości
		const simulate = (templates, units) => {
			let loot = 0;
			const counts = templates.map(() => 0);
			for (const x of active) {
				const rest = Object.assign({}, x.avail);
				const cf = x.v.unit_carry_factor || 1;
				templates.forEach((tp, i) => {
					if (!x.free.includes(tp.optionId)) { return; }
					if (units.some(u => rest[u] < tp.units[u])) { return; }
					units.forEach(u => { rest[u] -= tp.units[u]; });
					counts[i]++;
					loot += carryOf(tp.units, units) * cf * data.options[tp.optionId].loot_factor;
				});
			}
			const opt = data.options[templates[0].optionId];
			const seconds = duration(opt, carryOf(templates[0].units, units) * opt.loot_factor);
			return { loot, counts, seconds };
		};

		let best = null;
		let timeTooShort = false;
		for (const lv of subsets) {
			const invSum = lv.reduce((t, id) => t + 1 / data.options[id].loot_factor, 0);
			const share = id => (1 / data.options[id].loot_factor) / invSum;
			for (const { m } of mixes) {
				const units = unitIds.filter(u => m[u] > 0);
				// Zestaw dla skali s (s = 1 → wioska z tą mieszanką wysyła wszystkie zaznaczone jednostki)
				const templatesFor = s => lv.map(id => {
					const t = {};
					for (const u of units) { t[u] = Math.floor(m[u] * s * share(id)); }
					return { optionId: id, units: t };
				});
				const valid = tps => tps.every(tp => popOf(tp.units, units) >= MIN_POP);
				const consider = (s, tps) => {
					const r = simulate(tps, units);
					if (!r.loot) { return; }
					const perHour = r.loot / (r.seconds / 3600);
					const score = settings.mode === 'time' ? r.loot : perHour;
					if (!best || score > best.score) { best = { s, templates: tps, perHour, score, usedUnits: units, ...r }; }
				};
				if (settings.mode === 'time') {
					const opt = data.options[lv[0]];
					const haul = haulForDuration(opt, settings.hours * 3600);
					if (haul <= 0) { timeTooShort = fmtTime(duration(opt, 0)); continue; }
					const s = haul / (opt.loot_factor * share(lv[0]) * carryOf(m, units));
					const tps = templatesFor(s);
					if (valid(tps)) { consider(s, tps); }
				} else {
					for (let k = 0; k <= 120; k++) {
						const s = 0.05 * Math.pow(20, k / 120); // 0,05 … 1
						const tps = templatesFor(s);
						if (valid(tps)) { consider(s, tps); }
					}
				}
			}
		}
		if (!best) {
			if (timeTooShort) { throw 'Zadany czas jest za krótki – minimum to ok. ' + timeTooShort + '.'; }
			throw settings.mode === 'time'
				? 'Przy tym czasie nie da się złożyć oddziału min. 10 populacji – wydłuż czas.'
				: 'Za mało wojsk – żadna wioska nie złoży oddziału min. 10 populacji.';
		}
		// poziomy, na które żadna wioska nie wyśle, wypadają z planu (pozostałe i tak wracają razem)
		const keep = best.counts.map(c => c > 0);
		best.templates = best.templates.filter((_, i) => keep[i]);
		best.counts = best.counts.filter((_, i) => keep[i]);
		const usedUnits = best.usedUnits;
		const droppedUnits = unitIds.filter(u => !usedUnits.includes(u));
		return { ...best, usedUnits, droppedUnits, skippedLevels: levels.filter(id => !best.templates.some(t => t.optionId === id)), villageCount: active.length, pages: data.pages || 1 };
	}

	// ---------- Formularz gry ----------

	function setInput(input, value) {
		$(input).val(value === '' ? '' : String(value));
		['input', 'keyup', 'change'].forEach(ev => input.dispatchEvent(new Event(ev, { bubbles: true })));
	}

	// Wpisuje zestaw poziomu w wiersz wojsk gry i zaznacza kolumnę poziomu („Zaznacz wszystkie” gry).
	// Wcześniej odznacza wszystko inne, żeby z tym zestawem nie poszedł inny poziom.
	async function fillLevel(template) {
		const screen = $('#scavenge_mass_screen');
		const inputs = screen.find('.candidate-squad-widget input.unitsInput');
		if (!inputs.length) { throw 'Nie znaleziono formularza Zbieractwa masowego na tej stronie.'; }
		screen.find('.mass-scavenge-table input[type=checkbox]:checked').each(function () { $(this).trigger('click'); });
		inputs.each(function () { setInput(this, template.units[this.name] ? template.units[this.name] : ''); });
		// gra odblokowuje pola wyboru dopiero po przeliczeniu wpisanego zestawu – czekamy do 1,5 s
		const colBox = () => screen.find(`.select-all-col[data-option="${template.optionId}"]`);
		if (!colBox().length) { throw 'Nie znaleziono kolumny poziomu ' + template.optionId + '.'; }
		for (let i = 0; i < 15 && colBox().prop('disabled'); i++) { await new Promise(r => setTimeout(r, 100)); }
		if (colBox().prop('disabled')) { return 0; }
		colBox().trigger('click');
		// tylko przewinięcie widoku do tabeli i przycisku „Wyślij” (nad tabelą) – bez kursora na przycisku
		const table = screen.find('.mass-scavenge-table');
		if (table.length) { window.scrollTo({ top: Math.max(0, table.offset().top - 160), behavior: 'smooth' }); }
		return screen.find(`.mass-scavenge-table td.option-${template.optionId} input[type=checkbox]:checked`).length;
	}

	// Czy w kolumnie poziomu są jeszcze zaznaczone wioski (czyli nie kliknięto „Wyślij”)
	const stillTicked = optionId =>
		$(`#scavenge_mass_screen .mass-scavenge-table td.option-${optionId} input[type=checkbox]:checked`).length > 0;

	// ---------- Kolejne kroki (1 kliknięcie = 1 akcja) ----------

	function loadPlan() {
		const plan = storageGet('plan2');
		if (!plan || !plan.templates || Date.now() - plan.time > PLAN_TTL) { return null; }
		return plan;
	}

	async function nextStep() {
		const plan = loadPlan();
		if (!plan) { notify(NAME + ': brak aktualnego planu – kliknij „Oblicz zestaw”.'); return; }
		const step = plan.step;
		if (currentPage() !== step.page) { location.href = pageUrl(step.page); return; }

		// poprzedni poziom wypełniony, ale niewysłany – nie nadpisujemy go
		if (step.idx > 0 && step.idx <= plan.templates.length && stillTicked(plan.templates[step.idx - 1].optionId)) {
			notify(`${NAME}: najpierw kliknij „Wyślij” dla poziomu ${plan.templates[step.idx - 1].optionId}.`);
			return;
		}
		if (step.idx < plan.templates.length) {
			const tp = plan.templates[step.idx];
			const ticked = await fillLevel(tp);
			step.idx++;
			storageSet('plan2', plan);
			renderProgress(plan);
			notify(ticked
				? `${NAME}: strona ${step.page + 1}, poziom ${tp.optionId} – zaznaczono wiosek: ${ticked}. Sprawdź i kliknij „Wyślij”.`
				: `${NAME}: strona ${step.page + 1}, poziom ${tp.optionId} – żadna wioska nie ma tego zestawu. Kliknij skrót dla następnego kroku.`,
			ticked ? 'SuccessMessage' : 'ErrorMessage');
			return;
		}
		if (step.page + 1 < plan.pages) {
			plan.step = { page: step.page + 1, idx: 0 };
			storageSet('plan2', plan);
			location.href = pageUrl(plan.step.page);
			return;
		}
		storageRemove('plan2');
		renderProgress(null);
		notify(NAME + ': gotowe – wszystkie strony wypełnione.', 'SuccessMessage');
	}

	// ---------- Panel ----------

	function unitIcon(u) {
		return `<img src="${image_base}unit/unit_${u}.png" style="vertical-align:middle">`;
	}
	const unitsText = t => Object.keys(t).filter(u => t[u] > 0).map(u => `${unitIcon(u)}${fmt(t[u])}`).join(' ');

	function readPanel() {
		const s = JSON.parse(JSON.stringify(DEFAULTS));
		for (const u of SCAV_UNITS) {
			s.units[u] = $(`#${NS}_unit_${u}`).is(':checked');
			const raw = String($(`#${NS}_reserve_${u}`).val() ?? '').trim();
			s.reserve[u] = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw)) || 0);
		}
		s.levels = [1, 2, 3, 4].map(i => $(`#${NS}_level_${i}`).is(':checked'));
		s.mode = $(`input[name=${NS}_mode]:checked`).val() === 'time' ? 'time' : 'best';
		const hours = Number(String($(`#${NS}_hours`).val() ?? '').replace(',', '.'));
		s.hours = hours > 0 ? hours : DEFAULTS.hours;
		return s;
	}

	function renderPanel(settings) {
		const units = SCAV_UNITS.filter(u => game_data.units.includes(u));
		const unitRows = units.map(u => `
			<tr><td>${unitIcon(u)} ${UNIT_NAMES[u]}</td>
				<td style="text-align:center"><input type="checkbox" id="${NS}_unit_${u}" ${settings.units[u] ? 'checked' : ''}></td>
				<td><input type="number" min="0" id="${NS}_reserve_${u}" value="${settings.reserve[u]}" style="width:70px"></td></tr>`).join('');
		const levelBoxes = [1, 2, 3, 4].map(i =>
			`<label style="display:inline-block;white-space:nowrap;margin-right:14px"><input type="checkbox" id="${NS}_level_${i}" ${settings.levels[i - 1] ? 'checked' : ''}> ${i}</label>`).join('');

		$('#content_value').prepend(`
		<div id="${NS}" class="vis vis_item" style="margin-bottom:10px;padding:8px">
			<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small></h3>
			<p style="margin:0 0 8px 0">Zaznacz jednostki – skrypt sam dobierze zestaw dla wiosek z aktywnej grupy (wszystkie strony) i podzieli go na poziomy tak,
			żeby wszystko wróciło o jednej godzinie. Wypełnia formularz gry, a „Wyślij” klikasz sam.</p>
			<table class="vis" style="width:100%">
				<tr><th>Jednostka</th><th>Wysyłaj</th><th>Zostaw w wiosce</th></tr>
				${unitRows}
				<tr><th colspan="3">Poziomy i czas</th></tr>
				<tr><td>Poziomy</td><td colspan="2"><div style="white-space:nowrap">${levelBoxes}</div>
					<small>oddział musi mieć min. 10 populacji – przy małej liczbie wojsk skrypt sam pominie poziomy, które się nie opłacają</small></td></tr>
				<tr><td>Tryb</td><td colspan="2">
					<label><input type="radio" name="${NS}_mode" value="best" ${settings.mode !== 'time' ? 'checked' : ''}> <b>Najwięcej łupu na godzinę</b> – skrypt sam dobiera wielkość zestawu</label><br>
					<label><input type="radio" name="${NS}_mode" value="time" ${settings.mode === 'time' ? 'checked' : ''}> <b>Wróć po</b></label>
					<input type="text" id="${NS}_hours" value="${settings.hours}" style="width:40px"> h</td></tr>
			</table>
			<div id="${NS}_warn" style="margin-top:6px;color:#c00;font-weight:bold"></div>
			<div style="margin-top:8px"><input type="button" class="btn" id="${NS}_calc" value="Oblicz zestaw"></div>
			<div id="${NS}_plan" style="margin-top:8px"></div>
		</div>`);

		const update = () => {
			const s = readPanel();
			storageSet('settings2', s);
			const noReserve = units.filter(u => s.units[u] && !s.reserve[u]).map(u => UNIT_NAMES[u]);
			$('#' + NS + '_warn').html(noReserve.length
				? `Uwaga: bez rezerwy (${noReserve.join(', ')}) – zestaw może zabrać te jednostki w całości, także z wiosek atakowanych. ` +
				'Wpisz „Zostaw w wiosce” albo wybierz grupę bez atakowanych wiosek.'
				: '');
		};
		$('#' + NS).on('input change', 'input', update);
		update();
	}

	function renderPlan(plan) {
		const rows = plan.templates.map((tp, i) =>
			`<tr><td>Poziom ${tp.optionId}</td><td>${unitsText(tp.units)}</td><td>${plan.counts[i]} z ${plan.villageCount}</td></tr>`).join('');
		$('#' + NS + '_plan').html(`
			<p>Wszystkie oddziały wrócą po ok. <b>${fmtTime(plan.seconds)}</b>. Łup: <b>${fmt(plan.loot)}</b> surowców
			(${plan.pages > 1 ? 'wszystkie strony: ' + plan.pages : '1 strona'}).
			${plan.droppedUnits.length ? `<br><small>Pominięte jednostki (za mało ich w wioskach): ${plan.droppedUnits.map(u => UNIT_NAMES[u]).join(', ')}.</small>` : ''}${plan.skippedLevels && plan.skippedLevels.length ? `<br><small>Pominięte poziomy (za mało wojsk albo mniej łupu): ${plan.skippedLevels.join(', ')}.</small>` : ''}</p>
			<table class="vis" style="width:100%">
				<tr><th>Poziom</th><th>Zestaw (każda wioska)</th><th>Wiosek wyśle</th></tr>${rows}
			</table>
			<p style="margin-top:6px"><input type="button" class="btn" id="${NS}_next" value="Następny krok">
			<span id="${NS}_progress" style="margin-left:8px"></span></p>
			<small>Każde kliknięcie skrótu (albo „Następny krok”) wypełnia kolejny poziom albo przechodzi na następną stronę.
			Po każdym wypełnieniu sprawdź i kliknij „Wyślij” gry.</small>`);
		renderProgress(plan);
	}

	function renderProgress(plan) {
		const el = $('#' + NS + '_progress');
		if (!plan) { el.html('<b>Gotowe.</b>'); $(`#${NS}_next, #${NS}_next2`).addClass('btn-disabled'); return; }
		const { page, idx } = plan.step;
		const what = idx < plan.templates.length
			? `wypełnienie poziomu ${plan.templates[idx].optionId}`
			: (page + 1 < plan.pages ? `przejście na stronę ${page + 2}` : 'koniec');
		el.html(`Następnie: <b>${what}</b> (strona ${page + 1} z ${plan.pages})`);
	}

	// ---------- Start ----------

	try {
		// skrót wykonany dwa razy tuż po sobie (zdarza się w grze) liczy się jako jedno kliknięcie
		if (Date.now() - (window[NS + '_lastRun'] || 0) < 1500) { return; }
		window[NS + '_lastRun'] = Date.now();

		// Gra potrafi wyzerować game_data.mode w tle, więc ekran rozpoznajemy też po adresie i treści strony
		const onMassScreen = game_data.screen === 'place' && (game_data.mode === 'scavenge_mass' ||
			/[?&]mode=scavenge_mass(&|$)/.test(location.href) || $('#scavenge_mass_screen').length > 0);
		if (!onMassScreen) {
			const plan = loadPlan();
			location.href = pageUrl(plan ? plan.step.page : 0);
			return;
		}
		const premium = game_data.features && game_data.features.Premium;
		if (!premium || !premium.active) {
			notify(NAME + ': Zbieractwo masowe wymaga aktywnego Konta Premium.');
			return;
		}

		// panel już otwarty → skrót wykonuje następny krok planu
		if ($('#' + NS).length) {
			if (loadPlan()) { nextStep().catch(ex => notify(NAME + ': ' + ex)); }
			else { notify(NAME + ': kliknij „Oblicz zestaw”.', 'InfoMessage'); }
			return;
		}

		renderPanel(loadSettings());
		let busy = false;
		let existing = loadPlan();
		// zakończony plan z poprzedniego użycia – usuwamy po cichu, bez komunikatu „gotowe”
		if (existing && existing.step.idx >= existing.templates.length && existing.step.page + 1 >= existing.pages) {
			storageRemove('plan2');
			existing = null;
		}
		if (existing) {
			renderPlan(existing);
			nextStep().catch(ex => notify(NAME + ': ' + ex)); // np. po przejściu na następną stronę
		}

		$('#' + NS + '_calc').on('click', async () => {
			if (busy) { return; }
			busy = true;
			$('#' + NS + '_plan').html('<i>Pobieranie aktualnych wojsk ze wszystkich stron…</i>');
			try {
				const plan = createPlan(await fetchAllPages(), readPanel());
				plan.time = Date.now();
				plan.step = { page: currentPage() < plan.pages ? currentPage() : 0, idx: 0 };
				storageSet('plan2', plan);
				renderPlan(plan);
			} catch (ex) {
				$('#' + NS + '_plan').html('');
				storageRemove('plan2');
				notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'nie udało się pobrać danych z gry – spróbuj ponownie.'));
			} finally {
				busy = false;
			}
		});

		// drugi przycisk „Następny krok” tuż pod „Wyślij” gry – po wysłaniu nie trzeba wracać do skrótu na górze
		const sendRow = $('#scavenge_mass_screen .send-row').first();
		if (sendRow.length && !$('#' + NS + '_next2').length) {
			sendRow.after(`<div style="margin:6px 0;text-align:right"><input type="button" class="btn" id="${NS}_next2" value="Równe Zbieractwo: następny krok"></div>`);
		}
		$(document).on('click', `#${NS}_next, #${NS}_next2`, async () => {
			if (busy) { return; }
			busy = true;
			try { await nextStep(); }
			catch (ex) { notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'nie udało się wypełnić formularza.')); }
			finally { busy = false; }
		});
	} catch (ex) {
		notify(NAME + ' ' + VERSION + ': błąd – ' + (ex && ex.message ? ex.message : ex));
		console.error(NAME, ex);
	}
})();
