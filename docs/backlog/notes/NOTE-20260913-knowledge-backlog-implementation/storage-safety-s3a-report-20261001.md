# Raport S3a, 2026-10-01

Zadanie [RWK-20260928-sqlite-data-safety](../../rework/RWK-20260928-sqlite-data-safety.json)
pozostaje otwarte. Slice obejmuje trwałą publikację załączników i ich dostępność
podczas kopiowania migawki. Pełny protokół restore pozostaje w S3b,
harmonogramy i GUI w S4.

- Punkt startowy po fetch: `f2aeef2c7f29427ecff36c53450fbbb69f41c01a`, merge PR #69.
  Sprawdzenie ancestry potwierdziło obecność tego commita w `origin/main`.
- SHA pierwotnej implementacji: `ffdff68a67e76baa22238789f7712fd538230c48`.
- SHA po review: `af34b7b31b843281ee08305bff464045e2a3ce61`.
- Gałąź: `feat/sqlite-durable-attachments`.
- Osobny worktree: `/home/pioootrek/development/worktree-switcher-s3a`.
- PR: [#70](https://github.com/pioootrek/worktree-switcher/pull/70), otwarty do `main`.

## Prześledzone ścieżki i zmiana

Upload w `KnowledgeAttachmentService.upload` publikował przez `rename`, który
na POSIX nadpisywał obiekt. Import Huba w `SqliteStateStore.publishHubImport`
zapisywał bezpośrednio pod końcowym hashem. Import projektu przenosił pliki
z osobnego stagingu. Każda ścieżka próbowała usunąć nowy plik po błędzie SQL;
nie synchronizowała kompletu zawartości i wpisów katalogowych.
Backup kopiował pliki po ukończeniu Backup API, poza transakcją źródła.

Wszystkie trzy publikacje oraz kopie załączników backupu używają teraz
`publishAttachmentObject` z `src/server/attachment-objects.ts`. Warstwa knowledge
zachowuje `invalid_request` dla niebezpiecznych ścieżek i konfliktów treści.
Błędy systemu plików przechodzą do istniejącej obsługi błędów transportu.

Nowy obiekt powstaje w prywatnym stagingu 0700 w shardzie docelowym. Plik ma
0600 i jest otwierany wyłącznie przez `O_EXCL`/`O_NOFOLLOW`. Kopiowanie i hashowanie
używają bufora 64 KiB. Przed publikacją sprawdzane są rozmiar i SHA-256 zapisanych
bajtów oraz `fsync` pliku. `link` publikuje atomowo tylko przy nieistniejącym celu.
Wyścig z innym publisherem daje `EEXIST`, po którym weryfikowana i synchronizowana
jest zawartość zwycięzcy. Istniejący obiekt pozostaje na tym samym inode;
ponowienie nie wymaga kolejnego zapisu treści.

Po publikacji lub deduplikacji synchronizowane są plik końcowy, shard, katalog
obiektów i istniejący katalog nadrzędny danych albo stagingu backupu. Dotyczy to
także katalogów root/shard pozostałych po wcześniejszym przerwaniu. Publisher
tworzy tylko root/shard; nie tworzy katalogów ponad tą granicą. SQL może
zatwierdzić referencję dopiero po ukończeniu tej operacji.
Odmowa synchronizacji zatrzymuje zapis metadanych. W imporcie Huba zachowano
istniejącą transakcję IMMEDIATE i state machine batcha; import projektu nadal
zatwierdza cały snapshot w jednej transakcji.

Nowe katalogi są prywatne niezależnie od umask. Istniejące bezpieczne tryby
katalogów pozostają zachowane. Własne katalogi root/shard legacy z bitami zapisu
grupy/innych, np. 0775 po umask 002, są zawężane do 0700 przez sprawdzony
deskryptor, także podczas odczytu źródła backupu. Kanoniczne aliasy przodków
działają; symlinki roota, sharda lub obiektu, obca własność i zapisywalne
niezaufane ścieżki są odrzucane. Przodkowie ponad katalogiem danych/stagingu
są sprawdzani przez stat, bez wymagania odczytu katalogu i bez fsync.
Import projektu sprawdza też każdy rozmiar referencji współdzielących hash,
żeby mapowanie deduplikacji nie ukryło sprzecznych metadanych.

## Backup i sprzątanie

Opublikowane obiekty są niezmienne i pozostają zachowane, również po rollbacku
SQL lub usunięciu referencji. Sprzątanie usuwa wyłącznie prywatny staging własnej
operacji. Nie dodano automatycznego GC ani skanowania obiektów na starcie.
Błąd SQL może pozostawić kompletny orphan, a SIGKILL także staging. Ponowienie
weryfikuje i wykorzystuje kompletny obiekt; nie usuwa materiału poprzedniej próby.

To konserwatywna koordynacja z backupem: każdy obiekt, który może wejść do migawki,
pozostaje dostępny od rozpoczęcia Backup API aż do zakończenia kopiowania.
Backup odczytuje dokładnie unikalny zbiór referencji ze swojej kopii SQLite,
następnie publikuje zweryfikowane kopie obiektów w stagingu backupu.
Upload lub rollback importu nie zmienia źródłowych inode ani ich nie usuwa.

Pozostaje jeden właściciel aktywnej bazy i istniejące połączenie Backup API.
Odczyt kopii używa dotychczasowego połączenia read-only do pliku migawki.
Nie dodano połączenia do aktywnej bazy, lock map, liczników pinów ani nowej
koordynacji lifecycle. Offline restore nadal wymaga istniejącego locka właściciela.
Przyszłe GC lub nadpisywanie obiektów wymaga osobnego projektu ochrony snapshotów;
nie może opierać się na samych aktualnych referencjach SQL.

Formaty eksportu projektu i manifestu backupu, ścieżki `<prefix>/<sha256>`,
publiczne payloady i CLI pozostają zgodne. Schemat bazy nadal wynosi 28.
Backupy pozostają opcjonalne i domyślnie wyłączone.

## Weryfikacja

Pierwotne końcowe runy kolejki MCP wykonano pojedynczo na dokładnym odkrytym worktree,
czystym `ffdff68a67e76baa22238789f7712fd538230c48` i z `observed_match`.
Nie przejmowano ani nie uruchamiano zarządzanego serwera deweloperskiego.
Chromium sprawdza statyczny dashboard przez fixture; integracja uruchamia własne
izolowane kontrolery zbudowanego CLI i usuwa je po skończeniu.

| Polecenie | Wynik | ID runu |
| --- | --- | --- |
| `pnpm check` | passed, lint/typecheck, 632 Vitest w 83 plikach i 7 testów skryptów | `6f0f4f95-06e2-4426-8b6c-438bda46bb9c` |
| `pnpm build` | passed, statyczny eksport i bundle CLI | `d6a0173c-b985-453d-97fb-08baeeff22c7` |
| `pnpm test:integration` | passed, 25 testów w 5 plikach | `8a78b3de-94cb-4eb1-9668-b60f7b658c39` |
| `pnpm test:ui` | passed, 134 Chromium | `317db8c5-ea81-4dca-beb8-5d0abe86ac73` |

`pnpm smoke:package` przeszedł 14 kroków na tym samym czystym SHA przez
`llm-worker-heavy-runner`, ponieważ smoke nie ma presetu kolejki. Exit 0,
43,906 s, cleanup graceful. Paczkę zainstalowano w jednorazowym prefiksie
ze spacjami; natywne SQLite, offline CLI, auth, izolowany kontroler, zasoby
paczki i MCP przeszły. SHA-256 artefaktu:
`5a5a04450e0f07b25b358dd41dacd43c7f26bd5d9deeef4c3bcf6ef1398144f1`.
Była to świeża instalacja testowa, nie aktualizacja starego artefaktu.

Node 24.19.0, SQLite 3.53.4. Dziewięć testów SIGKILL używa jednorazowych baz
na ext4 obok repozytorium. Pozostałe fixture jednostkowe korzystają z `/tmp`,
które na tym hoście jest tmpfs.

Pokrycie nowych i zmienionych testów:

- SIGKILL dla uploadu, importu Huba i importu projektu: przed `link`, po `link`
  przed dalszym utrwaleniem oraz po INSERT w otwartej transakcji przed COMMIT.
  Po ponownym przejęciu własności brak przedwczesnych referencji; retry zatwierdza
  zgodne bajty i zwalnia lock.
- Realny błąd SQL wymuszony triggerem, rollback współdzielonego hashu i retry
  każdej z trzech ścieżek. Cudza zatwierdzona referencja nadal daje poprawne bajty.
- Dwa rzeczywiste procesy publikujące jeden hash oraz kontrolowany wyścig
  dokładnie między sprawdzeniem nieobecności i `link`. Jeden obiekt, bez nadpisania.
- Backup z uploadem/importem zatwierdzanym przed lub po wybraniu migawki;
  po snapshot usunięcie metadanych i rollback uploadu współdzielonego hashu.
  Manifest odpowiada wyłącznie referencjom migawki; wszystkie bajty są zgodne.
- Wstrzyknięte EIO, ENOSPC i EACCES przy zapisie, publikacji i synchronizacji;
  krótkie zapisy, rozmiary/hashy, konflikty, symlink, umask 000 i rzeczywista odmowa
  dostępu do katalogu. Retry po błędzie synchronizacji weryfikuje pozostawiony obiekt.
- Odmowa COMMIT metadanych wszystkich ścieżek po błędzie synchronizacji katalogu;
  błąd kopiowania backupu nie publikuje kopii ani nie niszczy źródła.
- Zbudowany CLI: upload, deduplikacja, idempotentny replay po restarcie,
  download i komplet bajtów w ręcznej kopii. Dotychczasowe round-trip formatów,
  auth, historyczne schematy i transporty nadal przechodzą.

Pierwsze runy robocze mają `dirty_source`, więc nie certyfikują żadnego SHA.
Typecheck wykrył typowanie mocka przeciążonego `writeSync`; pierwszy Vitest
wykrył fixture Huba bez testowego verifyPlan i złą kolejność usuwania FK
w fixture projektu. Kolejne checki ujawniły dodatkowy argument IPC oraz
założenie o umask w fixture aliasu. Wszystkie poprawiono. Ostatni roboczy check
miał exit 0 i 631 Vitest + 7 skryptów, ale jego faza pozostała failed ze względu
na nieczysty checkout. Końcowy check na czystym SHA jest passed.

Runy, ich source observations i output są zapisane w
[surowych dowodach](storage-safety-s3a-evidence-20261001.json).
`git diff --check` przeszedł. Pozostał wcześniejszy warning
`react-hooks/exhaustive-deps` w `knowledge-dashboard.tsx:87`.

## Ograniczenia i dalsze prace

SIGKILL sprawdza przerwanie procesu. Nie wykonano próby utraty zasilania,
awarii urządzenia, firmware ani kontroli gwarancji storage. Protokół używa
[synchronizacji pliku i katalogu](https://man7.org/linux/man-pages/man2/fsync.2.html)
oraz [publikacji bez nadpisania przez link](https://man7.org/linux/man-pages/man2/link.2.html).
Nie zbadano innych systemów plików ani macOS. ENOSPC jest fault injection;
nie zapełniano rzeczywistego dysku hosta.

Orphany i staging pozostały po przerwaniu mogą zajmować miejsce. Automatyczne
usuwanie byłoby ryzykowne dla współdzielonych referencji i kopii; S3a go nie
wprowadza. Nie zmierzono wydajności dużych załączników ani produkcyjnego SLO.
Obecne hashowanie całego pliku bazy backupu nie zostało zmienione w tym slice.
Trwała publikacja całego katalogu backupu i dziennikowany restore należą do S3b.

Nie używano produkcyjnej bazy, nie wdrażano kodu, nie restartowano usług hosta
ani nie zmieniano guardów, limitów lub watchdogów. Nie wykonano aktualizacji
starego zainstalowanego artefaktu, cutover ani późniejszego slice'a.
PR pozostaje do review; nie wykonano merge. Całe zadanie jest otwarte.

## Review follow-up, 2026-10-01

Odczytano wszystkie review submissions i wątki inline PR #70 wraz z odpowiedziami
i stanem; paginacja nie miała kolejnych stron. Trzy review submissions potwierdziły
te same dwa problemy. Klasyfikacja: 2 `fix`, 0 `backlog`, 0 `false positive`.

- [Katalogi legacy 0775](https://github.com/pioootrek/worktree-switcher/pull/70#discussion_r4156699166):
  wcześniejsze wydania tworzyły root/shard według umask. Odrzucanie tych katalogów
  blokowało upload/import i backup istniejących danych. Wprowadzono zawężanie
  tylko własnych root/shard przez `O_NOFOLLOW`/`O_DIRECTORY`, sprawdzenie właściciela,
  device/inode deskryptora, `fchmod(0700)` i `fsync`. Tryby bez zapisu grupy/innych
  są zachowane; symlinki, cudze katalogi i writable ancestors nie są naprawiane.
- [Nieczytelny przodek](https://github.com/pioootrek/worktree-switcher/pull/70#discussion_r4156699184):
  otwieranie wszystkich katalogów aż do `/` dodawało niepotrzebny wymóg read.
  Synchronizacja kończy się na istniejącym rodzicu rootu. Katalog nadrzędny
  jest ustalony przez własność bazy lub utworzenie stagingu backupu; publisher
  tworzy tylko root/shard. Retry synchronizuje wszystkie trzy katalogi,
  również jeśli poprzednia próba zdążyła utworzyć root/shard lub opublikować plik.
  Nieczytelne zewnętrzne przodki nadal podlegają kontroli ścieżki i uprawnień.

Poprawka jest w `af34b7b31b843281ee08305bff464045e2a3ce61`, opublikowanym normalnym
push na istniejącej gałęzi PR. Doszło 14 przypadków: prawdziwe root/shard 0775
przy publikacji i odczycie źródła, rzeczywisty przodek 0111, retry po EIO
po publikacji, brak open poza granicą fsync, odrzucenie aliasów i obcej własności
bez chmod, odmowa zmiany writable ancestor oraz backup/upload/oba importy
w konfiguracjach legacy i execute-only. Niezmienność inode/bajtów pozostaje
sprawdzana. Dziewięć dotychczasowych SIGKILL i konkurencyjni publisherzy przeszli.

Runy wykonano kolejno na czystym SHA poprawki; wszystkie mają `observed_match`:

| Polecenie | Wynik | ID runu |
| --- | --- | --- |
| `pnpm check` | passed, lint/typecheck, 646 Vitest w 83 plikach i 7 skryptów | `d43845cc-5e84-4e5d-a1e1-e0a9e1ade5f9` |
| `pnpm build` | passed, statyczny eksport i CLI | `35eb0474-c1dc-4cd9-8444-8f9bfa11d6b5` |
| `pnpm test:integration` | passed, 25 testów w 5 plikach | `a3410a81-69a5-4b0f-8eb9-671c34c3bd61` |

Odpowiedzi z klasyfikacją, SHA i wynikami opublikowano w oryginalnych wątkach,
następnie oba rozwiązano. Ponowny pełny odczyt potwierdził 2 resolved,
0 unresolved i obecność obu odpowiedzi. Stany przed/po i runy zapisano
w `reviewFollowUp` w [dowodach](storage-safety-s3a-evidence-20261001.json).
`git diff --check` przeszedł. Warning dashboardu pozostaje wcześniejszy.

Lokalnie nie powtarzano UI ani package smoke: ich wcześniejsze wyniki dotyczą wyłącznie
`ffdff68`, a nie SHA poprawki. Nowe fixture legacy odtwarzają uprawnienia starszych
wydań; nie są aktualizacją starego zainstalowanego artefaktu. Przypadki uprawnień
są na lokalnym tmpfs, SIGKILL nadal na ext4. Nie wykonano testu utraty zasilania,
realnego zapełnienia dysku, wdrożenia, użycia produkcyjnej bazy ani merge.
Backupy pozostają opcjonalne i domyślnie wyłączone; zadanie otwarte, S3b/S4 poza zakresem.

GitHub [Verify, run 36880723312](https://github.com/pioootrek/worktree-switcher/actions/runs/36880723312)
na SHA poprawki zakończył `check-build`, `package-smoke` na Node 22.23.2 i 24.21.0
oraz `package-service-lifecycle` z SUCCESS. Statusy odczytano z GitHub i zapisano
oddzielnie od lokalnych runów kolejki w dowodach review. Kanoniczne Hub `fmt`
i `validate` oraz `git diff --check` przeszły dla aktualizacji dokumentacji.
