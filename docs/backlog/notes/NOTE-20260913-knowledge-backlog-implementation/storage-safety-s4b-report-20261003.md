# S4b — szyfrowany transfer kopii, 2026-10-03

Status: odbiór lokalny zakończony; CI i scalenie jeszcze oczekują.
PR: https://github.com/pioootrek/worktree-switcher/pull/74
Rewizja: `04f4d0112d9c3516ae14f25978afbdabccaf97dc`.
Kod produkcyjny nie zmienił się od `6e2f72ebc44018d8d87143c2ca8ba1c966928f4a`.
Kodował jeden worker `gpt-6.1-sol`, reasoning `high`; root koordynował,
przeglądał, obsługiwał review i dokumentację. Bez wdrożenia produkcyjnego.

## Zakres

Transfer domyślnie jest wyłączony. Operator włącza go argumentami CLI usługi;
GUI, HTTP i MCP nie zmieniają polityki ani nie administrują transferem.
Prywatne pliki przechowują hasło repozytorium i dane logowania REST.
Pierwszy adapter obsługuje restic przez HTTPS REST i istniejące repozytorium.
Nie inicjalizuje celu, nie zmienia kluczy i nie wykonuje zdalnego prune/forget.
Dokładne argumenty i procedura odtworzenia są w README na gałęzi PR.

Wysyłane są wyłącznie ukończone, zweryfikowane kopie instalacji w katalogu
operatora. Eksporty użytkowników, kopie przed migracją i kopie do jawnego
celu CLI pozostają poza automatycznym transferem. Wykonanie współdzieli
istniejący executor backupów; adapter nie otwiera SQLite.

Trwały dziennik poza bazą wiąże operację z kryptograficznym ID repozytorium,
instalacją, kopią i manifestem. Oczekujące i nieudane źródła są chronione przed
retencją, także po wyłączeniu transferu. Limit jest sprawdzany przed utworzeniem
kolejnej kopii. Ponowienie najpierw uzgadnia istniejący stan zdalny; ręczna,
monotoniczna generacja otwiera nową ograniczoną serię prób. Historia potwierdzeń
jest usuwana dopiero po wycofaniu źródła i operacji, z zachowaniem ostatniego
potwierdzenia. Restore bazy nie cofa tego dziennika ani polityki CLI.

Restic zapewnia uwierzytelnione szyfrowanie. Adapter sprawdza ID repozytorium,
odczytuje zdalny manifest i kompletny wykaz plików, typów i rozmiarów.
Komunikaty postępu są strumieniowane z limitem pamięci, wyjścia i czasu.
Lokalny sukces, potwierdzenie transferu i dowód odzyskania są osobnymi stanami.
Pole recovery pozostaje `not-measured`; test fixture nie aktualizuje produkcji.

## Weryfikacja

Wszystkie poniższe zadania wykonała kolejka MCP na czystych rewizjach,
z `observed_match`. Nie uruchamiano zarządzanego serwera deweloperskiego.

| Zakres | Rewizja | Wynik | ID |
| --- | --- | --- | --- |
| Pełny check: lint, typy, Vitest, skrypty | `6e2f72e` | 920 + 7 testów | `fcaba669-2b5c-496c-a600-096724febd5d` |
| Testy transferu i regresji review | `04f4d01` | 32/32 | `eb251e28-2a92-46eb-9282-dabbb7360442` |
| Build | `04f4d01` | pass | `1aac834c-c2f9-4553-bb75-8269ce65bcd1` |
| Prawdziwy HTTPS REST i sąsiednie integracje | `04f4d01` | 8/8 | `e3f78a15-629a-4185-baf1-3d2318dbe4fc` |
| Zainstalowany pakiet | `04f4d01` | 16/16 | `6d587030-1fa2-4dbf-89f2-7783e22fb5ba` |

Fixture użył oficjalnych binariów restic 0.19.1 i rest-server 0.14.0,
zweryfikowanych sumami dystrybucji, z tymczasowym HTTPS, CA, uwierzytelnianiem
i repozytorium append-only na loopback. Produkcyjny adapter wysłał zadanie
z załącznikiem. Po usunięciu całej instalacji źródłowej wykonano restic restore
z `--verify`, walidację świeżej instalacji i uruchomienie odzyskanego kontrolera.
Przywrócony token pozwolił odczytać oryginalne zadanie i identyczne bajty
załącznika. Powtórzenie nie utworzyło drugiej migawki. Sprawdzono odmowę dla
błędnych poświadczeń, brakującego klucza i niezaufanego TLS, a także naprawę
poświadczeń, restart i ręczne ponowienie.

Odtworzenie maleńkiego fixture trwało 1682 ms. Nie jest to pomiar produkcyjnego
RTO ani dowód ochrony przed utratą fizycznego hosta.

Osobny smoke zainstalowanego npm tarballa przeszedł na Node 24.19.0,
z katalogiem globalnego prefixu zawierającym spacje, natywnym SQLite i poprawnym
zamknięciem procesów. Sprawdził domyślnie wyłączony transfer i istniejące
ścieżki instalacji/CLI/HTTP/MCP. Prawdziwy transfer HTTPS przetestowano na
zbudowanym CLI, nie na npm-installed CLI. Tarball: 851115 bajtów,
SHA-256 `2608c114997b659fcd42ada5a9bd40ca99633174845f4773e6b1edaea5401798`.
Szczegółowe sumy narzędzi, przebiegi i sanitowane logi są w pliku dowodów.

Wcześniejsze nieudane przebiegi pozostają dowodami: błędna tabela testów CLI,
typowanie NODE_ENV, naruszenie checksum historycznego dziennika przez domyślne
pole, brak Bearer w fixture oraz brak uruchomienia odzyskanego kontrolera przed
odczytem CLI. Wszystkie poprawiono; nie raportujemy ich jako zaliczonych prób.
Pozostało istniejące ostrzeżenie lint w selection.tab.

## Review n8n

Jedno zlecenie `all`; Claude, Kimi i Codex zakończyli review.
Cztery wątki: 2 fix, 1 backlog, 1 false positive; 0 nierozwiązanych po ponownym
odczycie wszystkich stron. Codex nie zgłosił dodatkowych problemów.

- Claude: buforowanie postępu restic poprawiono przez strumieniowanie i 1 FPS;
  regresja emituje ponad 1 MiB postępu przed poprawnym podsumowaniem.
- Claude: ID celu zależy od kryptograficznego repozytorium, a nie URL. Zmiana
  adresu tego samego repozytorium zachowuje historię. Zastąpienie repozytorium
  innym pozostaje S5; wyłączenie transferu umożliwia start i lokalną kopię
  ratunkową, zachowując przypięte źródła.
- Kimi: zarzut bezwzględnych ścieżek drzewa jest false positive. Prawdziwy restic
  zwrócił `/manifest.json`, `/state.sqlite3` i `/attachments/29/...`; pełne
  odtworzenie potwierdziło ten kontrakt.
- Kimi: limit 32 kandydatów pozostaje. README opisuje osobną procedurę operatora:
  zachować źródła i sprawdzony punkt odzyskania, niezależnie odtworzyć i porównać
  kandydatów, usunąć osobnymi uprawnieniami tylko dowiedzione niekompletne ID,
  bez prune i bez usuwania nieznanych, potwierdzonych lub ostatnich kopii.
  Regresja 34 kandydatów dowodzi bezpiecznej odmowy i ponownego uzgodnienia po
  takim porządkowaniu. Automatyczne odzyskanie historii pozostaje w S5.

## Pozostałe prace

Rodzic RWK-20260928-sqlite-data-safety pozostaje otwarty. S5 obejmuje niezależny
monitor, wybór celu poza hostem i przechowywania kluczy, reprezentatywne RPO/RTO,
rejestrowanie prób odzyskania, aktualizację starego i nowego zainstalowanego
artefaktu, migrację do innego repozytorium oraz ograniczoną automatyczną obsługę
częściowych migawek. Brak zmiany produkcji, odczytu jej bazy, wysyłki jej danych
lub poluzowania limitów hosta. Tymczasowy profil testowy usunięto.
