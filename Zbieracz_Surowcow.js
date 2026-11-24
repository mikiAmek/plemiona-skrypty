/*
 * Przesyłając modyfikację stworzoną przez użytkownika (skrypt) do wykorzystania w grze Tribal Wars,
 * twórca udziela firmie InnoGames wieczystej, nieodwołalnej, ogólnoświatowej, wolnej od opłat
 * licencyjnych, niewyłącznej licencji na używanie, reprodukcję, dystrybucję, publiczne wyświetlanie,
 * modyfikowanie oraz tworzenie dzieł pochodnych na podstawie tej modyfikacji. Licencja ta pozwala
 * firmie InnoGames na włączenie modyfikacji do dowolnego aspektu gry i powiązanych usług, w tym
 * działań promocyjnych i komercyjnych, bez konieczności wypłaty wynagrodzenia lub podania autora.
 * Osoba przesyłająca oświadcza i gwarantuje, że posiada prawne prawo do udzielenia tej licencji
 * oraz że modyfikacja nie narusza praw osób trzecich.
 */

/*
 * Zbieracz Surowców v3.0.0
 * Autor: Mavionis
 *
 * KROK 1 – Przeglądy > Produkcja: uruchom skrypt. Pojawi się panel z ustawieniami.
 *          (Uruchomiony na innym ekranie bez planu – przenosi do Przeglądy > Produkcja.)
 *          Skrypt sprawdza wszystkie wioski z aktywnej grupy i opracowuje plan:
 *          wioski-dawcy (wybrane wg grupy, pojemności spichlerza lub punktów) oddają surowce,
 *          a surowce trafiają do wybranej wioski albo do pozostałych wiosek. Możliwe jest też
 *          samo wyrównywanie surowców między wioskami (bez dawców).
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
	const VERSION = 'v3.0.0';
	const NS = 'Zbieracz_Surowcow';
	const MERCHANT_CAPACITY = 1000;
	const PLAN_TTL = 30 * 60 * 1000;
	const RES_NAMES = ['Drewno', 'Glina', 'Żelazo'];
	const RES_CLASSES = ['wood', 'stone', 'iron'];

	const DEFAULTS = {
		// 1. Dawcy
		useDonors: true,             // false – bez dawców, tylko wyrównywanie nadwyżek między wioskami
		donorByGroup: false,         // kryterium: wioska należy do grupy
		donorGroupId: '',            //   id grupy
		donorByStorage: true,        // kryterium: pojemność spichlerza
		donorMinCapacity: 400000,    //   od tej pojemności (400 000 = poziom 30)
		donorByPoints: false,        // kryterium: punkty wioski
		donorMinPoints: 9000,        //   od tej liczby punktów
		donorMatch: 'all',           // 'all' – wszystkie zaznaczone kryteria, 'any' – dowolne z nich
		donorKeep: [0, 0, 0],        // ile zostaje w dawcy (0 = opróżnij do zera)
		// 2. Odbiorcy
		mode: 'single',              // 'single' – do jednej wioski, 'spread' – do pozostałych wiosek
		targetId: '',                // wioska docelowa w trybie 'single'
		fillTo: [0, 0, 0],           // uzupełniaj do (0 = do limitu spichlerza)
		priorityLevel: [0, 0, 0],    // najpierw każdemu minimum (0 = bez minimum)
		fillPercent: 95,             // maks. zapełnienie spichlerza: nikt nie dostanie więcej, a wioska ponad próg oddaje nadwyżkę
		// 3. Ochrona – w każdej wiosce zawsze zostaje
		reserve: [0, 0, 0],          // surowce, poniżej których nie zejdzie żadna wioska poza dawcami
		tradersSafeguard: 0,         // wolni kupcy – w każdej wiosce, także w dawcach
		// 4. Transporty
		minTransport: 0,             // pomijaj transporty mniejsze niż tyle surowców łącznie
		countIncoming: true,         // doliczaj surowce już jadące do odbiorcy
		useRelays: true,             // szybsze dostawy przez pośredników
		maxDistance: 0               // maks. odległość, 0 = bez limitu
	};

	// ---------- Pomocnicze ----------

	const toNumber = text => Number(String(text).replace(/\D/g, '')) || 0;
	const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
	const fmt = n => Number(n).toLocaleString('pl-PL');


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

	function parseProduction(html, allowEmpty) {
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
			// Surowce: trzy liczby z tekstu komórki (jak w Dysponencie), np. "753 77 1.065".
			// Gdy tekst nie da trzech liczb – zapasowo po znacznikach .res.wood/.stone/.iron.
			const resText = $(row.cells[3]).text().trim().split(/\s+/).filter(t => /\d/.test(t));
			const resources = resText.length === 3
				? resText.map(toNumber)
				: RES_CLASSES.map(cls => toNumber($(row.cells[3]).find('.res.' + cls + ', .' + cls).first().text()));
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
				tradersFree: traders[0] || 0,
				tradersAll: traders[1] || 0
			});
		}
		if (!villages.length && !allowEmpty) { throw 'Nie wczytano żadnej wioski z przeglądu produkcji.'; }
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

	// Lista grup z menu „Grupy:” na stronie przeglądu; current = aktualnie wybrana grupa
	function parseGroups(html) {
		const doc = $('<div>').append($.parseHTML(html));
		const groups = [];
		doc.find('.group-menu-item').each(function () {
			const id = String($(this).attr('data-group-id') || '');
			if (!id) { return; }
			const name = $(this).text().trim().replace(/^[\[>]+|[\]<]+$/g, '').trim();
			groups.push({ id, name, current: this.tagName.toLowerCase() === 'strong' });
		});
		return groups;
	}

	// Skład grupy dawców. Gra pamięta ostatnio wybraną grupę, więc po odczycie
	// przywracamy grupę, którą gracz miał wybraną.
	const groupCache = {};
	let groupLoading = Promise.resolve();
	function loadGroupMembers(groupId, activeGroupId, force) {
		groupLoading = groupLoading.catch(() => {}).then(async () => {
			if (!force && groupCache[groupId]) { return groupCache[groupId]; }
			try {
				const html = await $.get('/game.php?screen=overview_villages&mode=prod&page=-1&group=' + groupId + sitterParam());
				groupCache[groupId] = new Set(parseProduction(html, true).map(v => v.id));
			} finally {
				if (String(activeGroupId) !== String(groupId)) {
					await $.get('/game.php?screen=overview_villages&mode=prod&group=' + activeGroupId + sitterParam()).catch(() => {});
				}
			}
			return groupCache[groupId];
		});
		return groupLoading;
	}

	async function fetchVillages() {
		const html = await $.get('/game.php?screen=overview_villages&mode=prod&page=-1' + sitterParam());
		const villages = parseProduction(html);
		villages.groups = parseGroups(html);
		const active = villages.groups.find(g => g.current);
		villages.activeGroupId = active ? active.id : String(game_data.group_id || '0');

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

	// Zwraca funkcję sprawdzającą, czy wioska jest dawcą wg zaznaczonych kryteriów.
	// groupMembers – zbiór id wiosek z wybranej grupy (gdy kryterium grupy jest włączone).
	function donorTest(settings, groupMembers) {
		if (!settings.useDonors) { return () => false; }
		const checks = [];
		if (settings.donorByGroup) {
			const members = groupMembers || new Set();
			checks.push(v => members.has(v.id));
		}
		if (settings.donorByStorage) {
			checks.push(v => v.capacity >= settings.donorMinCapacity);
		}
		if (settings.donorByPoints) {
			checks.push(v => v.points >= settings.donorMinPoints);
		}
		if (!checks.length) { return () => false; }
		return settings.donorMatch === 'any'
			? v => checks.some(c => c(v))
			: v => checks.every(c => c(v));
	}

	const hasCriteria = s => s.donorByGroup || s.donorByStorage || s.donorByPoints;

	function createPlan(villages, settings, groupMembers) {
		if (settings.useDonors && !hasCriteria(settings)) {
			throw 'Zaznacz co najmniej jedno kryterium dawcy albo wybierz „Bez dawców – tylko wyrównuj”.';
		}
		if (settings.useDonors && settings.donorByGroup && !settings.donorGroupId) {
			throw 'Wybierz grupę dawców.';
		}
		if (!settings.useDonors && settings.mode === 'single') {
			throw 'Przy „Bez dawców” możliwe jest tylko „Rozdziel do pozostałych wiosek”.';
		}
		const isDonor = donorTest(settings, groupMembers);
		const reserve = settings.reserve || [0, 0, 0];
		const byId = Object.fromEntries(villages.map(v => [v.id, v]));
		const inRange = (a, b) => settings.maxDistance <= 0 || distance(a.coords, b.coords) <= settings.maxDistance;
		const sum3 = a => a[0] + a[1] + a[2];

		// Stan każdej wioski w trakcie planowania
		const state = Object.fromEntries(villages.map(v => [v.id, {
			present: v.resources.slice(),                                   // surowce po wysyłkach z planu
			traders: Math.max(0, v.tradersFree - settings.tradersSafeguard) // kupcy do użycia
		}]));
		const tradersFor = amounts => Math.ceil(sum3(amounts) / MERCHANT_CAPACITY);

		// Próg przepełnienia (0 = wyłączony): powyżej niego wioska oddaje nadwyżkę
		// i nikt nie zostanie dopełniony ponad ten próg.
		// Jeden próg (jak w Dysponencie): nikt nie jest dopełniany ponad % spichlerza,
		// a wioska zapełniona ponad ten % oddaje nadwyżkę. Przy 100% ochrona nic nie robi.
		const overflowAt = v => settings.fillPercent < 100 ? Math.floor(v.capacity * settings.fillPercent / 100) : Infinity;

		// Docelowy poziom odbiorcy: najmniejsza z wartości – zadana ilość, % pojemności, próg przepełnienia
		const targetLevel = v => [0, 1, 2].map(i => {
			const byPercent = Math.min(Math.floor(v.capacity * settings.fillPercent / 100), overflowAt(v));
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
		const spare = Object.fromEntries(donors.map(v => [v.id, v.resources.map((r, i) => Math.max(0, r - settings.donorKeep[i]))]));

		// Surowce w drodze liczą się do wioski docelowej
		const incomingOf = v => settings.countIncoming ? v.incoming : [0, 0, 0];

		// Źródła surowców:
		//  priorytet 0 – dawcy: oddają wszystko ponad „Zostaw w dawcy”,
		//  priorytet 1 – pozostałe wioski: w trybie „rozdziel” nadwyżka ponad cel, w obu trybach
		//                nadwyżka ponad próg zapełnienia. Nigdy poniżej „W każdej wiosce zawsze zostaje”.
		// Wioska nie oddaje więcej, niż fizycznie ma.
		const sources = donors.map(v => ({ v, prio: 0 }));
		const targetId = settings.mode === 'single' ? String(settings.targetId) : null;
		for (const v of villages) {
			if (isDonor(v) || v.id === targetId) { continue; }
			const inc = incomingOf(v);
			const lvl = targetLevel(v);
			const floor = [0, 1, 2].map(i => {
				let f = settings.mode === 'spread' ? lvl[i] : Infinity;
				f = Math.min(f, overflowAt(v));
				return f === Infinity ? f : Math.max(f, reserve[i]);
			});
			const surplus = [0, 1, 2].map(i => floor[i] === Infinity ? 0
				: Math.max(0, Math.min(v.resources[i], v.resources[i] + inc[i] - floor[i])));
			if (sum3(surplus) > 0) {
				spare[v.id] = surplus;
				sources.push({ v, prio: 1 });
			}
		}

		// Zabezpieczenie (0 = wyłączone): najpierw każdy odbiorca do minimum, dopiero potem do celu
		const priority = settings.priorityLevel || [0, 0, 0];
		const passes = priority.some(x => x > 0)
			? [r => [0, 1, 2].map(i => priority[i] > 0 ? Math.min(priority[i], r.level[i]) : 0), r => r.level]
			: [r => r.level];

		const delivered = {}; // ile zaplanowano już dla odbiorcy
		const need = (r, levelFn) => {
			const lvl = levelFn(r);
			const got = delivered[r.village.id] || [0, 0, 0];
			return [0, 1, 2].map(i => Math.max(0, lvl[i] - r.village.resources[i] - incomingOf(r.village)[i] - got[i]));
		};

		// 1) Transporty bezpośrednie: źródło -> odbiorca; dawcy przed nadwyżkami, w ramach grupy najbliżsi
		let transports = [];
		for (const levelFn of passes) {
			// w każdym przebiegu najpierw odbiorcy z największym brakiem
			const ordered = receivers.slice().sort((a, b) => sum3(need(b, levelFn)) - sum3(need(a, levelFn)));
			for (const receiver of ordered) {
				const lack = need(receiver, levelFn);
				if (sum3(lack) <= 0) { continue; }
				const dist = v => distance(v.coords, receiver.village.coords);
				const candidates = sources
					.filter(src => src.v.id !== receiver.village.id && inRange(src.v, receiver.village))
					.sort((a, b) => a.prio - b.prio || dist(a.v) - dist(b.v))
					.map(src => src.v);

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

					const got = delivered[receiver.village.id] || (delivered[receiver.village.id] = [0, 0, 0]);
					for (let i = 0; i < 3; i++) {
						lack[i] -= amounts[i];
						got[i] += amounts[i];
						spare[d.id][i] -= amounts[i];
						st.present[i] -= amounts[i];
					}
					st.traders -= tradersFor(amounts);
					transports.push({ origin: d.id, destination: receiver.village.id, amounts, relay: false });
				}
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
					const canLend = [0, 1, 2].every(i => st.present[i] - reserve[i] >= t.amounts[i]);
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

		const caps = villages.map(v => v.capacity);
		const avg = [0, 1, 2].map(i => Math.floor(villages.reduce((sum, v) => sum + v.resources[i] + v.incoming[i], 0) / villages.length));
		const esc = t => $('<div>').text(t).html();

		const targetOptions = villages
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(v => `<option value="${v.id}" ${v.id === String(settings.targetId) ? 'selected' : ''}>${esc(v.name)} (${v.coords.x}|${v.coords.y})</option>`)
			.join('');
		const groupOptions = (villages.groups || [])
			.filter(g => g.id !== '0')
			.map(g => `<option value="${g.id}" ${g.id === String(settings.donorGroupId) ? 'selected' : ''}>${esc(g.name)}</option>`)
			.join('');
		const chk = (id, on) => `<input type="checkbox" id="${NS}_${id}" ${on ? 'checked' : ''}>`;
		const numIn = (id, val, w) => `<input id="${NS}_${id}" type="number" min="0" style="width:${w || 75}px" value="${val}">`;

		const html = `
		<div id="${NS}" class="vis vis_item" style="margin-bottom:10px;padding:8px">
			<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small>
				<a href="#" id="${NS}_toggleSettings" style="font-size:11px;font-weight:normal;margin-left:10px">Ukryj ustawienia</a></h3>
			<p style="margin:0 0 8px 0">Wiosek: <b>${villages.length}</b>, spichlerze: ${fmt(Math.min(...caps))} – ${fmt(Math.max(...caps))}.
			Transportów w drodze (przychodzących): <b id="${NS}_incomingCount">${villages.incomingCount}</b>.
			<span id="${NS}_incomingWarning">${villages.incomingWarning ? `<br><b style="color:#c00">Uwaga: ${villages.incomingWarning}.</b>` : ''}</span></p>
			<table class="vis" style="width:100%" id="${NS}_settings">
				<tr><th colspan="2">1. Skąd brać – DAWCY</th></tr>
				<tr><td style="width:260px">Tryb</td>
					<td><label><input type="radio" name="${NS}_useDonors" value="1" ${settings.useDonors ? 'checked' : ''}> <b>Z dawcami</b> – wybrane wioski oddają surowce</label><br>
					<label><input type="radio" name="${NS}_useDonors" value="0" ${!settings.useDonors ? 'checked' : ''}> <b>Bez dawców</b> – tylko wyrównuj (z nadmiaru do braku)</label></td></tr>
				<tr class="${NS}_donorRow"><td>Kto jest dawcą</td>
					<td><label>${chk('donorByGroup', settings.donorByGroup)} grupa</label>
					<select id="${NS}_donorGroupId"><option value="">— wybierz —</option>${groupOptions}</select><br>
					<label>${chk('donorByStorage', settings.donorByStorage)} spichlerz od pojemności</label> ${numIn('donorMinCapacity', settings.donorMinCapacity, 75)}<br>
					<label>${chk('donorByPoints', settings.donorByPoints)} punkty od</label> ${numIn('donorMinPoints', settings.donorMinPoints, 60)}<br>
					<select id="${NS}_donorMatch">
						<option value="all" ${settings.donorMatch !== 'any' ? 'selected' : ''}>muszą być spełnione wszystkie zaznaczone</option>
						<option value="any" ${settings.donorMatch === 'any' ? 'selected' : ''}>wystarczy jedno z zaznaczonych</option>
					</select>
					<br><b id="${NS}_donorCount"></b></td></tr>
				<tr class="${NS}_donorRow"><td>Zostaw w dawcy<br><small>0 = opróżnij do zera</small></td>
					<td>${resInputs('donorKeep', settings.donorKeep)}</td></tr>

				<tr><th colspan="2">2. Dokąd i ile – ODBIORCY</th></tr>
				<tr><td>Dokąd</td>
					<td><label><input type="radio" name="${NS}_mode" value="single" ${settings.mode === 'single' ? 'checked' : ''}> do jednej wioski</label>
					<select id="${NS}_targetId"><option value="">— wybierz —</option>${targetOptions}</select><br>
					<label><input type="radio" name="${NS}_mode" value="spread" ${settings.mode === 'spread' ? 'checked' : ''}> rozdziel do pozostałych wiosek</label></td></tr>
				<tr><td>Uzupełniaj do<br><small>0 = do limitu spichlerza</small></td>
					<td>${resInputs('fillTo', settings.fillTo)}
					<br><small>średnio na wioskę masz: ${avg.map(fmt).join(' / ')}</small></td></tr>
				<tr><td>Najpierw każdemu minimum<br><small>0 = bez minimum</small></td>
					<td>${resInputs('priorityLevel', settings.priorityLevel)}
					<br><small>gdy surowców jest mało, każda wioska dostaje najpierw tyle</small></td></tr>
				<tr><td>Maks. zapełnienie spichlerza</td>
					<td><input id="${NS}_fillPercent" type="number" min="1" max="100" style="width:50px" value="${settings.fillPercent}"> %
					<small>nikt nie dostanie więcej; wioska ponad ten próg oddaje nadwyżkę</small></td></tr>

				<tr><th colspan="2">3. Ochrona – W KAŻDEJ WIOSCE ZAWSZE ZOSTAJE</th></tr>
				<tr><td>Surowce<br><small>wszystkie wioski poza dawcami</small></td>
					<td>${resInputs('reserve', settings.reserve)}
					<br><small>żadna wioska (z nadmiarem, przepełniona ani pośrednik) nie zejdzie poniżej tego ani poniżej „Uzupełniaj do”</small></td></tr>
				<tr><td>Wolni kupcy<br><small>wszystkie wioski, także dawcy</small></td>
					<td>${numIn('tradersSafeguard', settings.tradersSafeguard, 50)}</td></tr>

				<tr><th colspan="2">4. Transporty</th></tr>
				<tr><td>Minimalny transport</td>
					<td>${numIn('minTransport', settings.minTransport, 75)} <small>mniejsze są pomijane</small></td></tr>
				<tr><td>Pozostałe</td>
					<td><label>${chk('countIncoming', settings.countIncoming)} doliczaj surowce w drodze</label> &nbsp;
					<label>${chk('useRelays', settings.useRelays)} szybciej przez pośredników</label> &nbsp;
					maks. odległość ${numIn('maxDistance', settings.maxDistance, 50)} <small>(0 = bez limitu)</small></td></tr>
			</table>
			<div id="${NS}_summary" class="info_box" style="margin-top:8px;padding:6px"></div>
			<div style="margin-top:8px">
				<input type="button" class="btn" id="${NS}_create" value="Opracuj plan">
				<input type="button" class="btn btn-disabled" id="${NS}_execute" value="Wykonaj plan">
			</div>
			<div id="${NS}_plan" style="margin-top:8px"></div>
		</div>`;

		$('#content_value').prepend(html);

		let countSeq = 0;
		const updateDonorCount = async () => {
			const s = readPanel();
			const seq = ++countSeq;

			// „Bez dawców”: wyszarzone pola dawców i wymuszony tryb „rozdziel”
			const off = !s.useDonors;
			$(`#${NS} tr.${NS}_donorRow`).css('opacity', off ? 0.4 : 1).find('input, select').prop('disabled', off);
			$(`input[name=${NS}_mode][value=single]`).prop('disabled', off);
			$('#' + NS + '_targetId').prop('disabled', off);
			if (off) { $(`input[name=${NS}_mode][value=spread]`).prop('checked', true); }
			$('#' + NS + '_summary').html(describe(readPanel(), villages));

			if (off) { $('#' + NS + '_donorCount').text(''); return; }
			if (!hasCriteria(s)) { $('#' + NS + '_donorCount').text('→ zaznacz co najmniej jedno kryterium'); return; }
			if (s.donorByGroup && !s.donorGroupId) { $('#' + NS + '_donorCount').text('→ wybierz grupę'); return; }

			let members = null;
			if (s.donorByGroup) {
				$('#' + NS + '_donorCount').text('→ wczytywanie grupy…');
				try { members = await loadGroupMembers(s.donorGroupId, villages.activeGroupId, false); }
				catch (e) { if (seq === countSeq) { $('#' + NS + '_donorCount').text('→ nie udało się wczytać grupy'); } return; }
			}
			if (seq !== countSeq) { return; } // w międzyczasie zmieniono ustawienia
			const count = villages.filter(donorTest(s, members)).length;
			$('#' + NS + '_donorCount').text(`→ dawców: ${count} z ${villages.length}`);
		};
		$('#' + NS).on('input change', `#${NS}_settings input, #${NS}_settings select`, updateDonorCount);
		updateDonorCount();

		$('#' + NS + '_toggleSettings').on('click', function (e) {
			e.preventDefault();
			const t = $('#' + NS + '_settings').toggle();
			$(this).text(t.is(':visible') ? 'Ukryj ustawienia' : 'Pokaż ustawienia');
		});

		let planReady = false; // „Wykonaj plan” działa tylko dla planu opracowanego teraz, a nie starego z pamięci

		let busy = false;
		$('#' + NS + '_create').on('click', async () => {
			if (busy) { return; }
			busy = true;
			planReady = false;
			storageRemove('plan');
			$('#' + NS + '_execute').addClass('btn-disabled');
			$('#' + NS + '_plan').html('<i>Pobieranie aktualnych danych wiosek…</i>');
			try {
				const s = readPanel();
				storageSet('settings', s);
				$('#' + NS + '_summary').html(describe(s, villages));
				// Zawsze świeże dane: surowce, kupcy i transporty w drodze z chwili kliknięcia
				const fresh = await fetchVillages();
				$('#' + NS + '_incomingCount').text(fresh.incomingCount);
				$('#' + NS + '_incomingWarning').html(fresh.incomingWarning ? `<br><b style="color:#c00">Uwaga: ${fresh.incomingWarning}.</b>` : '');
				const members = (s.useDonors && s.donorByGroup && s.donorGroupId)
					? await loadGroupMembers(s.donorGroupId, fresh.activeGroupId, true)
					: null;
				const summons = createPlan(fresh, s, members);
				renderPlan(summons, fresh);
				const now = new Date();
				$('#' + NS + '_plan').prepend(`<small>Dane z godziny ${now.toLocaleTimeString('pl-PL')}.</small>`);
				if (summons.length) {
					savePlan(summons);
					planReady = true;
					// po opracowaniu planu chowamy ustawienia, żeby plan był od razu widoczny
					$('#' + NS + '_settings').hide();
					$('#' + NS + '_toggleSettings').text('Pokaż ustawienia');
					$('#' + NS + '_execute').removeClass('btn-disabled');
				} else {
					$('#' + NS + '_plan').append(diagnose(fresh, s, members));
				}
			} catch (ex) {
				$('#' + NS + '_plan').html('');
				notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'nie udało się pobrać danych z gry – sprawdź połączenie i spróbuj ponownie.'));
			} finally {
				busy = false;
			}
		});

		$('#' + NS + '_execute').on('click', () => {
			const plan = planReady ? loadPlan() : null;
			if (!plan) { UI.ErrorMessage(planExpired ? noPlanMessage() : NAME + ': najpierw opracuj plan.', 5000); return; }
			location.href = callUrl(plan);
		});
	}

	// Wyjaśnienie „Brak transportów”: co skrypt widzi u odbiorców i dawców
	function diagnose(villages, s, members) {
		const isDonor = donorTest(s, members);
		const esc = t => $('<div>').text(t).html();
		const sum3 = a => a[0] + a[1] + a[2];
		const keep = s.donorKeep;
		const level = v => [0, 1, 2].map(i => {
			const over = s.fillPercent < 100 ? Math.floor(v.capacity * s.fillPercent / 100) : Infinity;
			const byPercent = Math.min(Math.floor(v.capacity * s.fillPercent / 100), over);
			return s.fillTo[i] > 0 ? Math.min(s.fillTo[i], byPercent) : byPercent;
		});
		const receivers = s.mode === 'single'
			? villages.filter(v => v.id === String(s.targetId))
			: villages.filter(v => !isDonor(v));
		const lines = [];
		for (const r of receivers.slice(0, 5)) {
			const inc = s.countIncoming ? r.incoming : [0, 0, 0];
			const lack = [0, 1, 2].map(i => Math.max(0, level(r)[i] - r.resources[i] - inc[i]));
			lines.push(`Odbiorca ${esc(r.name)}: ma ${r.resources.join('/')}, w drodze ${inc.join('/')}, cel ${level(r).join('/')} → brakuje ${lack.join('/')}`);
		}
		const donors = villages.filter(isDonor).filter(d => !(s.mode === 'single' && d.id === String(s.targetId)));
		if (!donors.length) { lines.push('Dawców: 0 – zmień kryteria dawców.'); }
		for (const d of donors.slice(0, 8)) {
			const spare = d.resources.map((r, i) => Math.max(0, r - keep[i]));
			const traders = Math.max(0, d.tradersFree - s.tradersSafeguard);
			lines.push(`Dawca ${esc(d.name)}: do oddania ${spare.join('/')} (razem ${sum3(spare)}), wolni kupcy do użycia: ${traders}`);
		}
		if (s.minTransport > 0) { lines.push(`Minimalny transport: ${s.minTransport} – mniejsze są pomijane.`); }
		return `<div style="margin-top:4px;font-size:11px">${lines.join('<br>')}</div>`;
	}

	// Opis ustawień zwykłymi słowami – pokazywany nad przyciskami
	function describe(s, villages) {
		const r3 = a => a.map(fmt).join(' / ');
		const set = a => a.some(x => x > 0);
		const lines = [];
		if (!s.useDonors) {
			lines.push('Bez dawców: surowce przechodzą z wiosek z nadmiarem do wiosek z brakiem.');
		} else {
			const crit = [];
			if (s.donorByGroup) {
				const g = ((villages && villages.groups) || []).find(x => x.id === String(s.donorGroupId));
				crit.push(g ? `grupa [${g.name}]` : 'grupa (nie wybrano)');
			}
			if (s.donorByStorage) { crit.push(`spichlerz od ${fmt(s.donorMinCapacity)}`); }
			if (s.donorByPoints) { crit.push(`od ${fmt(s.donorMinPoints)} pkt`); }
			lines.push(`Dawcy (${crit.join(s.donorMatch === 'any' ? ' lub ' : ' i ') || 'brak kryteriów'}) oddają ` +
				(set(s.donorKeep) ? `wszystko ponad ${r3(s.donorKeep)}.` : '<b>wszystko</b>.'));
		}
		const target = set(s.fillTo) ? `do <b>${r3(s.fillTo)}</b>` : 'do limitu spichlerza';
		lines.push((s.mode === 'single' ? 'Wszystko trafia do wybranej wioski, ' : 'Pozostałe wioski są uzupełniane ') +
			`${target}, maks. do ${s.fillPercent}% spichlerza.`);
		if (set(s.priorityLevel)) { lines.push(`Najpierw każda dostaje minimum ${r3(s.priorityLevel)}.`); }
		const givers = [];
		if (s.mode === 'spread') { givers.push('z nadmiarem'); }
		if (s.fillPercent < 100) { givers.push(`zapełnione ponad ${s.fillPercent}%`); }
		if (givers.length) {
			lines.push(`Wioski ${givers.join(' i ')} oddają nadwyżkę` +
				(set(s.reserve) ? `, ale zawsze zostaje w nich co najmniej <b>${r3(s.reserve)}</b>.` : '.'));
		}
		if (s.tradersSafeguard > 0) { lines.push(`W każdej wiosce (także w dawcach) zostaje ${s.tradersSafeguard} wolnych kupców.`); }
		if (s.minTransport > 0) { lines.push(`Transporty mniejsze niż ${fmt(s.minTransport)} są pomijane.`); }
		return `<b>Co zrobi plan:</b><br>• ${lines.join('<br>• ')}`;
	}

	function readPanel() {
		const num = id => Math.max(0, Number($('#' + NS + '_' + id).val()) || 0);
		const arr = id => [0, 1, 2].map(i => num(id + '_' + i));
		const s = {
			useDonors: $(`input[name=${NS}_useDonors]:checked`).val() !== '0',
			donorByGroup: $('#' + NS + '_donorByGroup').is(':checked'),
			donorGroupId: String($('#' + NS + '_donorGroupId').val() || ''),
			donorByStorage: $('#' + NS + '_donorByStorage').is(':checked'),
			donorMinCapacity: num('donorMinCapacity'),
			donorByPoints: $('#' + NS + '_donorByPoints').is(':checked'),
			donorMinPoints: num('donorMinPoints'),
			donorMatch: $('#' + NS + '_donorMatch').val() === 'any' ? 'any' : 'all',
			donorKeep: arr('donorKeep'),
			mode: $(`input[name=${NS}_mode]:checked`).val() || 'single',
			targetId: String($('#' + NS + '_targetId').val() || ''),
			fillTo: arr('fillTo'),
			priorityLevel: arr('priorityLevel'),
			fillPercent: Math.min(100, Math.max(1, num('fillPercent'))),
			reserve: arr('reserve'),
			tradersSafeguard: num('tradersSafeguard'),
			minTransport: num('minTransport'),
			countIncoming: $('#' + NS + '_countIncoming').is(':checked'),
			useRelays: $('#' + NS + '_useRelays').is(':checked'),
			maxDistance: num('maxDistance')
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
		$('form[name=call-resources] .btn').off('click.' + NS).on('click.' + NS, function () {
			// Gra wysyła wezwanie bez przeładowania strony – zdejmujemy kursor z przycisku,
			// żeby kolejny Enter nie wysłał pustego formularza
			setTimeout(() => { if (document.activeElement) { document.activeElement.blur(); } }, 0);
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

		// Kursor na przycisku gry – Enter wysyła wezwanie (jedno naciśnięcie = jedna akcja, jak w Dysponencie)
		const submit = $('form[name=call-resources] .btn').first();
		if (submit[0]) { submit[0].focus(); }

		const left = plan.summons.length - 1;
		let msg = `${NAME}: wypełniono ${filled} wiosek. Sprawdź i naciśnij Enter (albo kliknij „Poproś o surowce”).`;
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
