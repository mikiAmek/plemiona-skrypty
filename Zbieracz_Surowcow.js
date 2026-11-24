/*
 * Zbieracz Surowców v2.8.2
 * Autor: Mavionis
 *
 * KROK 1 – Przeglądy > Produkcja: uruchom skrypt. Pojawi się panel z ustawieniami.
 *          (Uruchomiony na innym ekranie bez planu – przenosi do Przeglądy > Produkcja.)
 *          Skrypt sprawdza wszystkie wioski z aktywnej grupy i opracowuje plan:
 *          wioski-dawcy (np. spichlerz na 30. poziomie) oddają surowce do zadanego
 *          minimum (np. 0), a surowce trafiają do wybranej wioski albo do pozostałych wiosek.
 * KROK 2 – „Wykonaj plan” przenosi na Rynek > Wezwij. Kliknij skrypt – wypełni formularz,
 *          wezwanie wysyłasz SAM przyciskiem „Poproś o surowce”. Kolejne wezwanie: kliknij skrypt
 *          (wczyta i wypełni formularz następnej wioski) i znów „Poproś o surowce”.
 *
 * Skrypt nigdy sam nie wysyła wezwań (1 kliknięcie = 1 akcja).
 * Plan jest ważny 30 minut.
 *
 * Sygnatura:
 * javascript:var ZbieraczSurowcow={};$.getScript('ADRES_SKRYPTU');void(0);
 *
 * Ustawienia można zmieniać w panelu – są zapamiętywane w przeglądarce.
 */

(async function () {
	'use strict';

	// Komunikat działający zawsze – także gdy strona gry nie ma okienek UI (np. wersja mobilna)
	const notify = (msg, type) => {
		if (typeof UI !== 'undefined' && UI[type || 'ErrorMessage']) { UI[type || 'ErrorMessage'](msg, 8000); }
		else { alert(String(msg).replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')); }
	};
	if (typeof game_data === 'undefined' || typeof jQuery === 'undefined') {
		notify('Zbieracz Surowców: uruchom skrypt na stronie gry Plemiona (wersja na komputer).');
		return;
	}

	const NAME = 'Zbieracz Surowców';
	const VERSION = 'v2.8.2';
	const NS = 'Zbieracz_Surowcow';
	const MERCHANT_CAPACITY = 1000;
	const PLAN_TTL = 30 * 60 * 1000;
	const RES_NAMES = ['Drewno', 'Glina', 'Żelazo'];
	const RES_CLASSES = ['wood', 'stone', 'iron'];

	const DEFAULTS = {
		donorByStorage: true,       // kryterium dawcy: poziom spichlerza
		donorMinLevel: 30,          //   spichlerz od tego poziomu
		donorByPoints: false,       // kryterium dawcy: punkty wioski
		donorMinPoints: 9000,       //   punkty od tej wartości
		donorMatch: 'all',          // 'all' – wszystkie zaznaczone kryteria, 'any' – dowolne z nich
		donorEmpty: true,           // true – opróżniaj dawców do 0, false – zostaw donorKeep
		donorKeep: [0, 0, 0],       // ile zostawić w dawcy, gdy donorEmpty = false
		tradersSafeguard: 0,        // ilu kupców zostawić wolnych w każdej wiosce
		mode: 'single',             // 'single' – do jednej wioski, 'spread' – do pozostałych wiosek
		targetId: '',               // wioska docelowa w trybie 'single'
		fillTo: [0, 0, 0],          // dopełniaj odbiorcę do tej ilości (0 = bez limitu ilości)
		fillPercent: 95,            // ale nigdy ponad % pojemności jego spichlerza (ochrona małych spichlerzy)
		maxDistance: 0,             // maks. odległość dawca–odbiorca, 0 = bez limitu
		minTransport: 0,            // pomijaj transporty mniejsze niż tyle surowców łącznie
		useRelays: true,            // szybsze dostawy przez pośredników
		relayKeep: [0, 0, 0],       // ile pośrednik musi mieć u siebie po pożyczeniu
		countIncoming: true         // doliczaj surowce już jadące do odbiorcy
	};

	// ---------- Pomocnicze ----------

	const toNumber = text => Number(String(text).replace(/\D/g, '')) || 0;
	const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
	const fmt = n => Number(n).toLocaleString('pl-PL');

	// Pojemność spichlerza na poziomie: 1000 * 1.2294934^(poziom-1) → 30 = 400 000
	const capacityForLevel = level => Math.round(1000 * Math.pow(1.2294934, level - 1));
	const levelForCapacity = cap => cap > 0 ? Math.round(Math.log(cap / 1000) / Math.log(1.2294934)) + 1 : 0;

	const sitterParam = () =>
		(game_data.player.sitter && game_data.player.sitter !== '0') ? '&t=' + game_data.player.id : '';

	function storageGet(key) {
		try { return JSON.parse(localStorage.getItem(NS + '_' + key)); } catch (e) { return null; }
	}
	function storageSet(key, value) {
		try { localStorage.setItem(NS + '_' + key, JSON.stringify(value)); } catch (e) { /* brak dostępu */ }
	}
	function storageRemove(key) {
		try { localStorage.removeItem(NS + '_' + key); } catch (e) { /* brak dostępu */ }
	}

	// ---------- Ustawienia ----------

	function loadSettings() {
		const settings = JSON.parse(JSON.stringify(DEFAULTS));
		const sources = [
			(typeof ZbieraczSurowcow !== 'undefined') ? ZbieraczSurowcow : {},
			storageGet('settings') || {}   // ostatnio użyte w panelu mają pierwszeństwo
		];
		for (const src of sources) {
			for (const key of Object.keys(src)) {
				if (!(key in DEFAULTS)) { continue; }
				if (typeof src[key] !== typeof DEFAULTS[key]) { continue; }
				if (Array.isArray(DEFAULTS[key]) && (!Array.isArray(src[key]) || src[key].length !== 3)) { continue; }
				settings[key] = src[key];
			}
		}
		return settings;
	}

	// ---------- Dane wiosek (Przeglądy > Produkcja) ----------

	function parseProduction(html) {
		const table = $('<div>').append($.parseHTML(html)).find('#production_table')[0] || $('#production_table')[0];
		if (!table) { throw 'Nie znaleziono tabeli przeglądu produkcji.'; }

		const villages = [];
		for (let i = 1; i < table.rows.length; i++) {
			const row = table.rows[i];
			if (row.cells.length < 6) { continue; }
			const link = $(row.cells[1]).find('.quickedit-vn')[0];
			const coordsMatch = $(row.cells[1]).text().match(/\d{1,3}\|\d{1,3}/g);
			if (!link || !coordsMatch) { continue; }

			const [x, y] = coordsMatch[coordsMatch.length - 1].split('|').map(Number);
			const resources = RES_CLASSES.map(cls => toNumber($(row.cells[3]).find('.res.' + cls).text()));
			const capacity = toNumber($(row.cells[4]).text());
			const traders = $(row.cells[5]).text().split('/').map(toNumber);
			const labelEl = $(link).find('.quickedit-label');
			const name = (labelEl.attr('data-text') || labelEl.text()).trim();

			villages.push({
				id: String(link.dataset.id),
				name,
				points: toNumber($(row.cells[2]).text()),
				coords: { x, y },
				resources,
				capacity,
				level: levelForCapacity(capacity),
				tradersFree: traders[0] || 0,
				tradersAll: traders[1] || 0
			});
		}
		if (!villages.length) { throw 'Nie wczytano żadnej wioski z przeglądu produkcji.'; }
		return villages;
	}

	// Przeglądy > Transporty > Przychodzące: surowce w drodze, zsumowane wg wioski docelowej
	function parseIncoming(html) {
		const incoming = {};
		const table = $('<div>').append($.parseHTML(html)).find('#trades_table')[0];
		if (!table) { return { incoming, count: 0, unknown: 0 }; } // brak tabeli = brak transportów w drodze

		let count = 0;
		let unknown = 0;
		for (let i = 1; i < table.rows.length; i++) {
			const cells = table.rows[i].cells;
			if (cells.length < 9) { continue; } // wiersz sumy / nagłówek
			const link = $(cells[4]).find('a[href*="id="]')[0];
			if (!link) { continue; }
			const id = String(new URL(link.href, location.origin).searchParams.get('id'));
			if (!incoming[id]) { incoming[id] = [0, 0, 0]; }

			$(cells[8]).find('.nowrap').each(function () {
				const icon = $(this).find('.icon.header')[0];
				if (!icon) { return; }
				let index = RES_CLASSES.findIndex(cls => icon.classList.contains(cls));
				if (index === -1) { index = RES_NAMES.indexOf(icon.title); } // jak w Dysponencie: po tytule ikony
				if (index === -1) { unknown++; return; }
				incoming[id][index] += toNumber($(this).text());
			});
			count++;
		}
		return { incoming, count, unknown };
	}

	async function fetchVillages() {
		const html = await $.get('/game.php?screen=overview_villages&mode=prod&page=-1' + sitterParam());
		const villages = parseProduction(html);

		// Pobierane zawsze – checkbox w panelu decyduje tylko, czy są liczone.
		// Błąd odczytu nie blokuje skryptu, ale jest wyraźnie pokazany w panelu.
		let incoming = {};
		villages.incomingCount = 0;
		villages.incomingWarning = '';
		try {
			const inc = await $.get('/game.php?screen=overview_villages&mode=trader&type=inc&page=-1' + sitterParam());
			const parsed = parseIncoming(inc);
			incoming = parsed.incoming;
			villages.incomingCount = parsed.count;
			if (parsed.unknown) { villages.incomingWarning = `nie rozpoznano ${parsed.unknown} pozycji surowców w transportach`; }
		} catch (ex) {
			villages.incomingWarning = 'nie udało się odczytać transportów w drodze – NIE są liczone';
		}
		for (const v of villages) { v.incoming = incoming[v.id] || [0, 0, 0]; }
		return villages;
	}

	// ---------- Planowanie ----------

	// Zwraca funkcję sprawdzającą, czy wioska jest dawcą wg zaznaczonych kryteriów
	function donorTest(settings) {
		const checks = [];
		if (settings.donorByStorage) {
			const minCapacity = capacityForLevel(settings.donorMinLevel);
			checks.push(v => v.capacity >= minCapacity);
		}
		if (settings.donorByPoints) {
			checks.push(v => v.points >= settings.donorMinPoints);
		}
		if (!checks.length) { return () => false; }
		return settings.donorMatch === 'any'
			? v => checks.some(c => c(v))
			: v => checks.every(c => c(v));
	}

	function createPlan(villages, settings) {
		if (!settings.donorByStorage && !settings.donorByPoints) { throw 'Zaznacz co najmniej jedno kryterium dawcy.'; }
		const isDonor = donorTest(settings);
		const byId = Object.fromEntries(villages.map(v => [v.id, v]));
		const inRange = (a, b) => settings.maxDistance <= 0 || distance(a.coords, b.coords) <= settings.maxDistance;
		const sum3 = a => a[0] + a[1] + a[2];

		// Stan każdej wioski w trakcie planowania
		const state = Object.fromEntries(villages.map(v => [v.id, {
			present: v.resources.slice(),                                   // surowce po wysyłkach z planu
			traders: Math.max(0, v.tradersFree - settings.tradersSafeguard) // kupcy do użycia
		}]));
		const tradersFor = amounts => Math.ceil(sum3(amounts) / MERCHANT_CAPACITY);

		// Docelowy poziom odbiorcy: mniejsza z wartości – zadana ilość albo % pojemności spichlerza
		const targetLevel = v => [0, 1, 2].map(i => {
			const byPercent = Math.floor(v.capacity * settings.fillPercent / 100);
			return settings.fillTo[i] > 0 ? Math.min(settings.fillTo[i], byPercent) : byPercent;
		});

		let receivers;
		if (settings.mode === 'single') {
			const target = byId[String(settings.targetId)];
			if (!target) { throw 'Wybierz wioskę docelową.'; }
			receivers = [{ village: target, level: targetLevel(target) }];
		} else {
			receivers = villages.filter(v => !isDonor(v)).map(v => ({ village: v, level: targetLevel(v) }));
		}

		const donors = villages.filter(isDonor);
		const keep = settings.donorEmpty ? [0, 0, 0] : settings.donorKeep;
		const spare = Object.fromEntries(donors.map(v => [v.id, v.resources.map((r, i) => Math.max(0, r - keep[i]))]));

		// Najpierw odbiorcy z największym brakiem
		// Brak u odbiorcy liczymy razem z surowcami, które już do niego jadą
		const incomingOf = v => settings.countIncoming ? v.incoming : [0, 0, 0];
		const need = r => [0, 1, 2].map(i => Math.max(0, r.level[i] - r.village.resources[i] - incomingOf(r.village)[i]));
		receivers.sort((a, b) => sum3(need(b)) - sum3(need(a)));

		// 1) Transporty bezpośrednie: dawca -> odbiorca, najbliżsi dawcy najpierw
		let transports = [];
		for (const receiver of receivers) {
			const lack = need(receiver);
			const candidates = donors
				.filter(d => d.id !== receiver.village.id && inRange(d, receiver.village))
				.sort((a, b) => distance(a.coords, receiver.village.coords) - distance(b.coords, receiver.village.coords));

			for (const d of candidates) {
				if (sum3(lack) <= 0) { break; }
				const st = state[d.id];
				let carry = st.traders * MERCHANT_CAPACITY;
				const amounts = [0, 1, 2].map(i => {
					const take = Math.min(lack[i], spare[d.id][i], carry);
					carry -= take;
					return take;
				});
				if (sum3(amounts) <= 0) { continue; }
				if (sum3(amounts) < settings.minTransport) { continue; } // za mały transport – pomijamy

				for (let i = 0; i < 3; i++) {
					lack[i] -= amounts[i];
					spare[d.id][i] -= amounts[i];
					st.present[i] -= amounts[i];
				}
				st.traders -= tradersFor(amounts);
				transports.push({ origin: d.id, destination: receiver.village.id, amounts, relay: false });
			}
		}

		// 2) Pośrednicy: zamiast D ------> R robimy P -> R (szybko) oraz D -> P (uzupełnienie P).
		//    Pośrednik jest użyty tylko, gdy obie trasy są krótsze od trasy bezpośredniej.
		if (settings.useRelays) {
			transports.sort((a, b) =>
				distance(byId[b.origin].coords, byId[b.destination].coords) -
				distance(byId[a.origin].coords, byId[a.destination].coords));

			const result = [];
			for (const t of transports) {
				const D = byId[t.origin];
				const R = byId[t.destination];
				const direct = distance(D.coords, R.coords);
				const needTraders = tradersFor(t.amounts);

				let best = null;
				let bestDist = direct;
				for (const P of villages) {
					if (P.id === D.id || P.id === R.id) { continue; }
					const legs = Math.max(distance(D.coords, P.coords), distance(P.coords, R.coords));
					if (legs >= bestDist) { continue; }
					if (!inRange(D, P) || !inRange(P, R)) { continue; }
					const st = state[P.id];
					if (st.traders < needTraders) { continue; }
					const canLend = [0, 1, 2].every(i => st.present[i] - settings.relayKeep[i] >= t.amounts[i]);
					if (!canLend) { continue; }
					best = P;
					bestDist = legs;
				}

				if (!best) { result.push(t); continue; }

				const st = state[best.id];
				for (let i = 0; i < 3; i++) { st.present[i] -= t.amounts[i]; } // pożycza teraz, odzyska z uzupełnienia
				st.traders -= needTraders;
				result.push({ origin: best.id, destination: R.id, amounts: t.amounts.slice(), relay: true });
				result.push({ origin: D.id, destination: best.id, amounts: t.amounts.slice(), relay: true });
			}
			transports = result;
		}

		// 3) Scalenie transportów na tej samej trasie i grupowanie w wezwania wg wioski docelowej
		const merged = {};
		for (const t of transports) {
			const key = t.origin + '>' + t.destination;
			if (!merged[key]) { merged[key] = { origin: t.origin, destination: t.destination, amounts: [0, 0, 0], relay: false }; }
			for (let i = 0; i < 3; i++) { merged[key].amounts[i] += t.amounts[i]; }
			merged[key].relay = merged[key].relay || t.relay;
		}

		const summons = {};
		for (const t of Object.values(merged)) {
			if (!summons[t.destination]) { summons[t.destination] = { destination: t.destination, transports: [] }; }
			summons[t.destination].transports.push({ origin: t.origin, amounts: t.amounts, relay: t.relay });
		}
		return Object.values(summons);
	}

	function savePlan(summons) {
		storageSet('plan', { timestamp: Date.now(), group: String(game_data.group_id || ''), summons });
	}

	let planExpired = false;
	function loadPlan() {
		const plan = storageGet('plan');
		if (!plan || !plan.summons || !plan.summons.length) { return null; }
		if (Date.now() - plan.timestamp > PLAN_TTL) {
			storageRemove('plan');
			planExpired = true;
			return null;
		}
		return plan;
	}
	const noPlanMessage = () => planExpired
		? NAME + ': plan wygasł (ważny 30 min, dane mogły się zmienić). Opracuj nowy w Przeglądy > Produkcja.'
		: NAME + ': brak planu. Uruchom skrypt w Przeglądy > Produkcja i opracuj plan.';

	function callUrl(plan) {
		let url = '/game.php?village=' + plan.summons[0].destination + '&screen=market&mode=call' + sitterParam();
		if (plan.group) { url += '&group=' + plan.group; }
		return url;
	}

	// ---------- Panel w Przeglądzie produkcji ----------

	function resInputs(prefix, values) {
		return RES_CLASSES.map((cls, i) =>
			`<span class="res ${cls}" style="padding-left:18px"></span>` +
			`<input id="${NS}_${prefix}_${i}" type="number" min="0" style="width:75px" value="${values[i]}"> `
		).join('');
	}

	function renderPanel(villages, settings) {
		$('#' + NS).remove();

		const levels = villages.map(v => v.level);

		const targetOptions = villages
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(v => `<option value="${v.id}" ${v.id === String(settings.targetId) ? 'selected' : ''}>${$('<div>').text(v.name).html()} (${v.coords.x}|${v.coords.y})</option>`)
			.join('');

		const html = `
		<div id="${NS}" class="vis vis_item" style="margin-bottom:10px;padding:8px">
			<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small>
				<a href="#" id="${NS}_toggleSettings" style="font-size:11px;font-weight:normal;margin-left:10px">Ukryj ustawienia</a></h3>
			<p style="margin:0 0 8px 0">Wiosek: <b>${villages.length}</b>, poziomy spichlerzy: ${Math.min(...levels)}–${Math.max(...levels)}.
			Transportów w drodze (przychodzących): <b>${villages.incomingCount}</b>.
			${villages.incomingWarning ? `<br><b style="color:#c00">Uwaga: ${villages.incomingWarning}.</b>` : ''}</p>
			<table class="vis" style="width:100%" id="${NS}_settings">
				<tr><th colspan="2">Dawcy</th></tr>
				<tr><td style="width:260px"><label><input type="checkbox" id="${NS}_donorByStorage" ${settings.donorByStorage ? 'checked' : ''}> Spichlerz od poziomu</label></td>
					<td><input id="${NS}_donorMinLevel" type="number" min="1" max="30" style="width:50px" value="${settings.donorMinLevel}"></td></tr>
				<tr><td><label><input type="checkbox" id="${NS}_donorByPoints" ${settings.donorByPoints ? 'checked' : ''}> Punkty wioski od</label></td>
					<td><input id="${NS}_donorMinPoints" type="number" min="0" style="width:75px" value="${settings.donorMinPoints}"></td></tr>
				<tr><td>Wioska musi spełniać</td>
					<td><label><input type="radio" name="${NS}_donorMatch" value="all" ${settings.donorMatch !== 'any' ? 'checked' : ''}> wszystkie zaznaczone kryteria</label>
					<label><input type="radio" name="${NS}_donorMatch" value="any" ${settings.donorMatch === 'any' ? 'checked' : ''}> dowolne z nich</label>
					<br><b id="${NS}_donorCount"></b></td></tr>
				<tr><td>Ile zabrać z dawcy</td>
					<td><label><input type="radio" name="${NS}_donorEmpty" value="1" ${settings.donorEmpty ? 'checked' : ''}> wszystko (opróżnij do 0)</label><br>
					<label><input type="radio" name="${NS}_donorEmpty" value="0" ${!settings.donorEmpty ? 'checked' : ''}> zostaw w dawcy:</label>
					${resInputs('donorKeep', settings.donorKeep)}</td></tr>
				<tr><td>Zostaw wolnych kupców w każdej wiosce</td>
					<td><input id="${NS}_tradersSafeguard" type="number" min="0" style="width:50px" value="${settings.tradersSafeguard}"></td></tr>

				<tr><th colspan="2">Odbiorcy</th></tr>
				<tr><td><label><input type="radio" name="${NS}_mode" value="single" ${settings.mode === 'single' ? 'checked' : ''}> Wszystko do jednej wioski</label></td>
					<td><select id="${NS}_targetId"><option value="">— wybierz —</option>${targetOptions}</select></td></tr>
				<tr><td><label><input type="radio" name="${NS}_mode" value="spread" ${settings.mode === 'spread' ? 'checked' : ''}> Rozdziel do pozostałych wiosek</label></td>
					<td>(wszystkie wioski, które nie są dawcami)</td></tr>
				<tr><td>Dopełniaj odbiorcę do ilości<br><small>0 = bez limitu ilości</small></td>
					<td>${resInputs('fillTo', settings.fillTo)}</td></tr>
				<tr><td>…ale maks. do % pojemności spichlerza<br><small>chroni małe spichlerze przed przepełnieniem</small></td>
					<td><input id="${NS}_fillPercent" type="number" min="1" max="100" style="width:50px" value="${settings.fillPercent}"> %
					<span id="${NS}_fillExample"></span></td></tr>
				<tr><td><label><input type="checkbox" id="${NS}_countIncoming" ${settings.countIncoming ? 'checked' : ''}> Doliczaj surowce w drodze</label>
</td>
					<td>zapobiega podwójnemu wezwaniu i przepełnieniu po dojeździe transportów</td></tr>
				<tr><td>Maks. odległość (0 = bez limitu)</td>
					<td><input id="${NS}_maxDistance" type="number" min="0" style="width:50px" value="${settings.maxDistance}"></td></tr>

				<tr><th colspan="2">Transporty</th></tr>
				<tr><td>Minimalny transport (surowce łącznie)<br><small>mniejsze są pomijane, np. 5000</small></td>
					<td><input id="${NS}_minTransport" type="number" min="0" style="width:75px" value="${settings.minTransport}"></td></tr>
				<tr><td><label><input type="checkbox" id="${NS}_useRelays" ${settings.useRelays ? 'checked' : ''}> Szybciej przez pośredników</label>
					<br><small>bliska wioska wysyła od razu do odbiorcy,<br>a daleki dawca uzupełnia ją później</small></td>
					<td>pośrednik zostawia u siebie co najmniej: ${resInputs('relayKeep', settings.relayKeep)}</td></tr>
			</table>
			<div style="margin-top:8px">
				<input type="button" class="btn" id="${NS}_create" value="Opracuj plan">
				<input type="button" class="btn btn-disabled" id="${NS}_execute" value="Wykonaj plan">
			</div>
			<div id="${NS}_plan" style="margin-top:8px"></div>
		</div>`;

		$('#content_value').prepend(html);

		const updateDonorCount = () => {
			const s = readPanel();
			const test = donorTest(s);
			const count = villages.filter(test).length;
			const info = s.donorByStorage ? ` (spichlerz ≥ ${fmt(capacityForLevel(s.donorMinLevel))})` : '';
			$('#' + NS + '_donorCount').text(`→ dawców: ${count} z ${villages.length}${info}`);
		};
		$('#' + NS).on('input change', `#${NS}_donorByStorage, #${NS}_donorMinLevel, #${NS}_donorByPoints, #${NS}_donorMinPoints, input[name=${NS}_donorMatch]`, updateDonorCount);
		updateDonorCount();

		// Podgląd: do ilu realnie zostanie dopełniony najmniejszy i największy spichlerz
		const updateFillExample = () => {
			const pct = Math.min(100, Math.max(1, Number($('#' + NS + '_fillPercent').val()) || 0));
			const caps = villages.map(v => v.capacity);
			const ex = cap => fmt(Math.floor(cap * pct / 100));
			$('#' + NS + '_fillExample').text(` → najmniejszy spichlerz: maks. ${ex(Math.min(...caps))}, największy: maks. ${ex(Math.max(...caps))} na surowiec`);
		};
		$('#' + NS + '_fillPercent').on('input', updateFillExample);
		updateFillExample();

		$('#' + NS + '_toggleSettings').on('click', function (e) {
			e.preventDefault();
			const t = $('#' + NS + '_settings').toggle();
			$(this).text(t.is(':visible') ? 'Ukryj ustawienia' : 'Pokaż ustawienia');
		});

		let planReady = false; // „Wykonaj plan” działa tylko dla planu opracowanego teraz, a nie starego z pamięci

		$('#' + NS + '_create').on('click', () => {
			planReady = false;
			try {
				const s = readPanel();
				storageSet('settings', s);
				const summons = createPlan(villages, s);
				renderPlan(summons, villages);
				if (summons.length) {
					savePlan(summons);
					planReady = true;
					// po opracowaniu planu chowamy ustawienia, żeby plan był od razu widoczny
					$('#' + NS + '_settings').hide();
					$('#' + NS + '_toggleSettings').text('Pokaż ustawienia');
					$('#' + NS + '_execute').removeClass('btn-disabled');
				} else {
					storageRemove('plan');
					$('#' + NS + '_execute').addClass('btn-disabled');
				}
			} catch (ex) { UI.ErrorMessage(NAME + ': ' + ex, 6000); }
		});

		$('#' + NS + '_execute').on('click', () => {
			const plan = planReady ? loadPlan() : null;
			if (!plan) { UI.ErrorMessage(planExpired ? noPlanMessage() : NAME + ': najpierw opracuj plan.', 5000); return; }
			location.href = callUrl(plan);
		});
	}

	function readPanel() {
		const num = id => Math.max(0, Number($('#' + NS + '_' + id).val()) || 0);
		const arr = id => [0, 1, 2].map(i => num(id + '_' + i));
		const s = {
			donorByStorage: $('#' + NS + '_donorByStorage').is(':checked'),
			donorMinLevel: Math.min(30, Math.max(1, num('donorMinLevel'))),
			donorByPoints: $('#' + NS + '_donorByPoints').is(':checked'),
			donorMinPoints: num('donorMinPoints'),
			donorMatch: $(`input[name=${NS}_donorMatch]:checked`).val() === 'any' ? 'any' : 'all',
			donorEmpty: $(`input[name=${NS}_donorEmpty]:checked`).val() !== '0',
			donorKeep: arr('donorKeep'),
			tradersSafeguard: num('tradersSafeguard'),
			mode: $(`input[name=${NS}_mode]:checked`).val() || 'single',
			targetId: String($('#' + NS + '_targetId').val() || ''),
			fillTo: arr('fillTo'),
			fillPercent: Math.min(100, Math.max(1, num('fillPercent'))),
			maxDistance: num('maxDistance'),
			minTransport: num('minTransport'),
			useRelays: $('#' + NS + '_useRelays').is(':checked'),
			relayKeep: arr('relayKeep'),
			countIncoming: $('#' + NS + '_countIncoming').is(':checked')
		};
		return s;
	}

	function renderPlan(summons, villages) {
		const byId = Object.fromEntries(villages.map(v => [v.id, v]));
		const label = id => {
			const v = byId[id];
			return v ? `${$('<div>').text(v.name).html()} (${v.coords.x}|${v.coords.y})` : id;
		};
		const resCells = a => a.map((n, i) => `<td><span class="res ${RES_CLASSES[i]}" style="padding-left:18px">${fmt(n)}</span></td>`).join('');

		if (!summons.length) {
			$('#' + NS + '_plan').html('<b>Brak transportów:</b> brak dawców z wolnymi kupcami, brak nadwyżek albo odbiorcy są pełni.');
			return;
		}

		let total = [0, 0, 0];
		let rows = '';
		summons.forEach((s, idx) => {
			const sum = s.transports.reduce((t, tr) => t.map((v, i) => v + tr.amounts[i]), [0, 0, 0]);
			total = total.map((v, i) => v + sum[i]);
			const relays = s.transports.some(tr => tr.relay) ? ' <small>(pośrednik)</small>' : '';
			// Wiersz wioski docelowej – kliknięcie rozwija/zwija listę wiosek wysyłających
			rows += `<tr class="${NS}_dest" data-idx="${idx}" style="cursor:pointer" title="Kliknij, aby rozwinąć">` +
				`<th><span class="${NS}_arrow">▶</span> ${idx + 1}. ${label(s.destination)} ` +
				`<small>(${s.transports.length} wiosk${s.transports.length === 1 ? 'a' : 'i'})</small>${relays}</th>` +
				`${resCells(sum).replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>')}</tr>`;
			for (const tr of s.transports) {
				const tag = tr.relay ? ' <small>(pośrednik)</small>' : '';
				rows += `<tr class="row_b ${NS}_src" data-idx="${idx}" style="display:none">` +
					`<td style="padding-left:28px">${label(tr.origin)}${tag}</td>${resCells(tr.amounts)}</tr>`;
			}
		});

		$('#' + NS + '_plan').html(`
			<p>Wezwań: <b>${summons.length}</b> (tyle razy klikniesz „Poproś o surowce”). Razem:
			${total.map((n, i) => `${RES_NAMES[i]} ${fmt(n)}`).join(', ')}.
			&nbsp; <a href="#" id="${NS}_expandAll">Rozwiń wszystko</a> | <a href="#" id="${NS}_collapseAll">Zwiń wszystko</a>
			| <a href="#" id="${NS}_togglePlan">Ukryj plan</a></p>
			<div id="${NS}_planBox" style="max-height:320px;overflow-y:auto;border:1px solid #c1a264">
				<table class="vis" style="width:100%">${rows}</table>
			</div>`);

		const setOpen = (idx, open) => {
			$(`#${NS}_plan tr.${NS}_src[data-idx="${idx}"]`).toggle(open);
			$(`#${NS}_plan tr.${NS}_dest[data-idx="${idx}"] .${NS}_arrow`).text(open ? '▼' : '▶');
		};
		$(`#${NS}_plan tr.${NS}_dest`).on('click', function () {
			const idx = $(this).data('idx');
			setOpen(idx, !$(`#${NS}_plan tr.${NS}_src[data-idx="${idx}"]`).first().is(':visible'));
		});
		$(`#${NS}_expandAll`).on('click', e => { e.preventDefault(); summons.forEach((_, i) => setOpen(i, true)); });
		$(`#${NS}_collapseAll`).on('click', e => { e.preventDefault(); summons.forEach((_, i) => setOpen(i, false)); });
		$(`#${NS}_togglePlan`).on('click', function (e) {
			e.preventDefault();
			const box = $(`#${NS}_planBox`).toggle();
			$(this).text(box.is(':visible') ? 'Ukryj plan' : 'Pokaż plan');
		});
	}

	// ---------- Ekran Rynek > Wezwij ----------

	function getCallRows() {
		const rows = {};
		// Struktura ekranu Wezwij: <tr class="supply_location" data-village="ID">
		//   pola resource[ID][wood|stone|iron] (zablokowane do zaznaczenia) + checkbox select-village
		$('#village_list tr.supply_location').each(function () {
			const id = String($(this).data('village'));
			const checkbox = $(this).find('input[name="select-village"]')[0];
			const fields = RES_CLASSES.map(res => $(this).find(`input[name="resource[${id}][${res}]"]`)[0]);
			if (!checkbox || fields.some(f => !f)) { return; }
			rows[id] = { checkbox, fields };
		});
		return rows;
	}

	// Odznacza wioski zaznaczone ręcznie, których nie ma w wezwaniu – żeby nie poszły razem z planem
	function clearRow(row) {
		if (row.checkbox.checked) { $(row.checkbox).trigger('click'); }
		row.fields.forEach(field => { $(field).val(''); });
	}

	function fillRow(row, amounts) {
		if (!row.checkbox.checked) { $(row.checkbox).trigger('click'); } // gra odblokowuje pola i wpisuje maksimum
		row.fields.forEach((field, i) => {
			$(field).prop('disabled', false).val(amounts[i]).trigger('change');
		});
	}

	// Wczytuje formularz Wezwij następnej wioski docelowej w miejsce bieżącego (bez przeładowania strony),
	// dzięki czemu jedno kliknięcie skryptu = przejście + wypełnienie.
	// Wioska, do której wyśle formularz Wezwij widoczny na stronie (z adresu formularza)
	function formVillage() {
		const form = $('form[name="call-resources"]')[0];
		if (!form) { return null; }
		try {
			return new URL(form.getAttribute('action') || '', location.href).searchParams.get('village');
		} catch (e) { return null; }
	}

	async function loadCallFormFor(plan) {
		const html = await $.get(callUrl(plan));
		const doc = $('<div>').append($.parseHTML(html)); // bez wykonywania skryptów strony
		const newForm = doc.find('form[name="call-resources"]')[0];
		if (!newForm) { throw 'Nie udało się wczytać ekranu Wezwij wioski docelowej.'; }

		const oldForm = $('form[name="call-resources"]')[0];
		if (!oldForm) { throw 'Nie znaleziono formularza Wezwij na tej stronie.'; }
		$(oldForm).replaceWith(newForm);

		if (String(formVillage()) !== String(plan.summons[0].destination)) {
			throw 'Wczytany formularz należy do innej wioski – przerwano dla bezpieczeństwa.';
		}

		const targetName = doc.find('#menu_row2_village').text().trim() || ('ID ' + plan.summons[0].destination);
		const targetCoords = doc.find('#menu_row2_village').closest('tr').find('b.nowrap').first().text().trim();
		$('#' + NS + '_banner').remove();
		$(newForm).before(
			`<div id="${NS}_banner" class="info_box" style="margin:5px 0"><div class="content">` +
			`<b>${NAME}:</b> wezwanie do wioski <b>${$('<div>').text(targetName + ' ' + targetCoords).html()}</b> ` +
			`(formularz wczytany przez skrypt – bieżąca wioska w nagłówku gry się nie zmienia).</div></div>`
		);
	}

	async function executeOnCallScreen(plan) {
		const summon = plan.summons[0];
		// Sprawdzamy wioskę formularza, a nie nagłówka gry – formularz mógł być już podmieniony przez skrypt
		const shownVillage = formVillage() || String(game_data.village.id);
		if (String(shownVillage) !== String(summon.destination)) {
			await loadCallFormFor(plan);
		}

		const rows = getCallRows();
		const planned = new Set(summon.transports.map(tr => String(tr.origin)));
		for (const id of Object.keys(rows)) {
			if (!planned.has(id)) { clearRow(rows[id]); }
		}

		let filled = 0;
		const missing = [];
		for (const tr of summon.transports) {
			const row = rows[String(tr.origin)];
			if (!row) { missing.push(tr.origin); continue; }
			fillRow(row, tr.amounts);
			filled++;
		}

		// Wezwanie zaliczamy po kliknięciu przycisku gry – tylko raz, nawet przy kilku przyciskach,
		// i tylko jeśli to wezwanie jest nadal pierwsze w planie (ochrona przed podwójnym odhaczeniem)
		let counted = false;
		$('form[name=call-resources] .btn').off('click.' + NS).on('click.' + NS, () => {
			if (counted) { return; }
			counted = true;
			const current = loadPlan();
			if (!current || String(current.summons[0].destination) !== String(summon.destination)) { return; }
			current.summons.shift();
			if (current.summons.length) {
				storageSet('plan', current);
			} else {
				storageRemove('plan');
			}
		});

		const left = plan.summons.length - 1;
		let msg = `${NAME}: wypełniono ${filled} wiosek. Sprawdź i kliknij „Poproś o surowce”.`;
		msg += left ? ` Potem kliknij skrypt – wczyta i wypełni następne wezwanie (zostało: ${left}).` : ' To ostatnie wezwanie z planu.';
		if (missing.length) {
			msg += `<br><b>Brak na liście ${missing.length} wiosek wysyłających</b> – wybierz grupę [wszystkie] ` +
				'i ustaw „Liczba wiosek na stronie” co najmniej na liczbę swoich wiosek.';
		}
		UI.SuccessMessage(msg, 8000);
	}

	// ---------- Start ----------

	try {
		// Panel działa w każdym przeglądzie wiosek (dane i tak są pobierane z Produkcji),
		// bo gra nie zawsze ma mode=prod w adresie – pamięta ostatnio wybrany przegląd.
		const isProd = game_data.screen === 'overview_villages';
		const isCall = game_data.screen === 'market' &&
			(game_data.mode === 'call' || /[?&]mode=call(&|$)/.test(location.href));

		if (isProd) {
			if ($('#' + NS).length) { $('#' + NS).remove(); return; } // drugie kliknięcie chowa panel
			notify(NAME + ': wczytywanie wiosek…', 'InfoMessage');
			if (!$('#content_value').length) { throw 'Nie znaleziono treści strony – włącz wersję gry na komputer.'; }
			const settings = loadSettings();
			const villages = await fetchVillages();
			renderPanel(villages, settings);
			return;
		}

		if (isCall) {
			const plan = loadPlan();
			if (!plan) {
				UI.ErrorMessage(noPlanMessage(), 6000);
				return;
			}
			await executeOnCallScreen(plan);
			return;
		}

		const plan = loadPlan();
		if (plan) {
			location.href = callUrl(plan);
		} else {
			// Poza Przeglądami i bez planu: przejście do Przeglądy > Produkcja bieżącej wioski
			// (np. https://zz1.tribalwars.works/game.php?village=2708&screen=overview_villages&mode=prod).
			// Tam kolejne kliknięcie skryptu otworzy panel.
			location.href = '/game.php?village=' + game_data.village.id + '&screen=overview_villages&mode=prod' + sitterParam();
		}
	} catch (ex) {
		notify(NAME + ': ' + ex);
		console.error(NAME, ex);
	}
})();
