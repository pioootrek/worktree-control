# K0: kontrakt wiedzy i importu Huba

Aktualizacja 2026-09-27: K0 zamknięte w
[DONE-20260927-knowledge-k0-contracts](../../done/DONE-20260927-knowledge-k0-contracts.json).
To historyczny kontrakt wejściowy. Aktualne API i schematy wynikają z kodu;
stan K1–K9 opisuje [plan wdrożenia](implementation-plan.md). Zamknięcie K0
nie zatwierdza migracji prawdziwego projektu.

Stan: techniczny kontrakt wejściowy dla K1–K6, ustalony 2026-09-13. Nie jest
to kontrakt dostępnego już API ani zgoda na zapis prawdziwych danych.

## Punkt odniesienia

Switcher sprawdzono w `7a17fb42b23cb4115f4955bdbc9fa6ebae054c5e`, a Hub
w `22afb656c74b2fde84cb92f1aefcf8b427697cc6`. Operacja usuwania projektu oraz
fundament zdalnej weryfikacji istniały już w bazowej rewizji Switchera
`72452b5c842b21e918c56cfe9910dc39746a2a98`. Diff do punktu odniesienia K0
obejmuje plan wiedzy oraz późniejsze zmiany UI i testów usuwania projektu;
nie jest dowodem powstania tych kontraktów po bazowej rewizji. Szczegółowe,
pozbawione treści prywatnej pomiary są w `k0-hub-inventory.json`.

Odczyt `listProjects()` jest zapytaniem SQLite. Dopiero jawne odświeżenie
metadanych wywołuje skan Git. Odczyty wiedzy muszą zachować tę granicę.

## Rozstrzygnięte kontrakty

### Projekt wiedzy i usuwanie

- `KnowledgeProject` ma losowe UUID, nazwę, stan `active|archived`, rewizję oraz
  czas utworzenia i zmiany. Nie wymaga repozytorium, remote ani portu.
- Rejestr runtime `projects` oraz `RemoteProjectIdentity` pozostają modelami
  innych zdolności. Wiedza używa jawnych mapowań
  `knowledge_project_runtime_links` i `knowledge_project_remote_links`.
- Każde mapowanie jest unikalne po stronie runtime/remote i może zostać
  odłączone. Utworzenie lub ponowna rejestracja tej samej ścieżki nie tworzy
  mapowania automatycznie.
- `DELETE FROM projects` usuwa wyłącznie mapowanie przez `ON DELETE SET NULL`
  albo kontrolowaną operację odłączenia. Rekordy wiedzy nigdy nie mają
  kaskadowego klucza obcego do `projects`.
- Fizyczne kasowanie projektu wiedzy nie wchodzi do pierwszego wydania.
  Archiwizacja jest odwracalną mutacją rewizjonowaną.

Jawne mapowanie jest wybrane zamiast rozszerzenia `RemoteProjectIdentity`, bo
ten kontrakt poprawnie wymaga `sourceRemote`, a projekt wiedzy nie musi mieć
repozytorium. Mapowanie zapobiega dwóm niezależnym interpretacjom tej samej
tożsamości i pozwala zachować bieżący kontrakt zdalnej weryfikacji.

### Principal, uwierzytelnienie i granty

Aktualizacja zakresu z 2026-09-17: [plan globalnych trybów](../NOTE-20260909-self-hosted-saas-plan/authentication-modes-and-plugin.md)
wprowadza przyszły pełny dostęp do instalacji dla `open` i jednego tokena.
Zastępuje wymóg osobnego poświadczenia wiedzy właściciela; poniższe granice
scoped grantów i legacy obowiązują odpowiednio dla delegowanych poświadczeń
oraz stanu przed migracją. Operacje anonimowe, także zatwierdzenia, muszą
zachować prawdziwe oznaczenie braku uwierzytelnienia zamiast udawać człowieka.

- K1 promuje wspólną część `RemotePrincipal` do transportowo neutralnego
  `Principal` z `id`, `kind: owner|agent|worker` i `status: active|revoked`.
  Zdalna weryfikacja zachowuje zgodną fasadę podczas migracji; nie powstaje
  druga tabela principal dla wiedzy.
- Principal nie jest poświadczeniem. Osobny rekord poświadczenia zapisuje
  mechanizm uwierzytelnienia, hash/verifier, ważność i odwołanie. Nazwa
  klienta, modelu oraz importowane `human:*`/`agent:*` są tylko metadanymi.
- Grant wiedzy wiąże principal z `KnowledgeProject` i jawnym zbiorem operacji:
  `knowledge:read`, `knowledge:write`, `knowledge:approve`,
  `knowledge:export`, `knowledge:import`, `attachments:read` i
  `attachments:write`. Żaden grant runtime nie implikuje grantu wiedzy ani
  odwrotnie.
- Autoryzacja jest sprawdzana przy każdym żądaniu, subskrypcji, pobraniu pliku
  i odtworzeniu wyniku idempotentnego. Odwołanie działa bez restartu serwera.
- Bieżący pairing token i wspólny MCP bearer nie dowodzą trwałej tożsamości
  człowieka. Dopóki K1 nie dostarczy uwierzytelnionego ownera, pamięć może być
  wyłącznie propozycją, a `knowledge:approve` nie jest wydawane.

### Rewizje, historia i idempotencja

- Każdy mutowalny rekord ma dodatnią rewizję. Aktualizacja wymaga
  `expectedRevision`; brak zgodności zwraca stabilny `revision_conflict` wraz
  z bieżącą rewizją, bez nadpisania szkicu klienta.
- Zapis rekordu, relacji, wpisu historii i klucza idempotencji jest jedną
  transakcją właściciela SQLite.
- Klucz idempotencji jest unikalny dla `(principal_id, knowledge_project_id,
  operation, key)`, a rekord zawiera hash kanonicznego żądania i wynik.
  Powtórka tego samego hasha zwraca wynik dopiero po ponownej autoryzacji.
  Inny hash zwraca `idempotency_conflict`.
- Historia jest append-only i przechowuje stan sprzed zmiany, principal,
  mechanizm uwierzytelnienia, czas oraz nową rewizję. Zatwierdzenie wskazuje
  konkretną rewizję i nie przechodzi na późniejszą edycję.

### Relacje i źródła

- Relacja wewnętrzna ma typ, dwa końce należące do tego samego projektu i
  własną rewizję. Serwis odrzuca relację między projektami.
- Referencja zewnętrzna przechowuje opis, źródłowy identyfikator lub URL i nie
  jest rozwiązywana automatycznie. Import działa w dwóch przebiegach; brak celu
  pozostaje jawnym `unresolved`, a nie zgadywanym powiązaniem.
- Źródło importu ma identyfikator repozytorium, dokładny commit, ścieżkę,
  legacy ID, hash kanonicznego payloadu, oryginalny payload i wersję reguł
  mapowania. Unikalność to `(source_id, legacy_id, source_path)`.

### Import i limity

- K6 użyje przypiętej, zaufanej wersji validatora Huba dla `planImport`, a nie
  skryptów z importowanego repozytorium. Parser TypeScript nie będzie
  deklarowany jako zgodny bez testów różnicowych; Python nie staje się
  zależnością codziennego kontrolera.
- `planImport` czyta zamrożony commit i odkrywa rekordy niezależnie od
  `index.json`. Rozwiązuje wszystkie cztery override'y schematu i odkrywa
  wszystkie pliki katalogu notatki, również nieobecne w polu `files`.
- Początkowe limity do pomiaru: strona 25, maksimum 100; mutacja 64 KiB;
  kompaktowy kontekst 256 KiB. Limit importu i plików jest odrębny.

## Mapowanie Huba

| Źródło | Cel | Zasada bezstratności |
| --- | --- | --- |
| `feature/fix/rework/security` | zadanie | Zachować rodzaj, area, stan, priorytet, scope, validation, ryzyko i pełny payload źródłowy. |
| `notes[]` zadania | historyczny komentarz | Autor jest deklarowany; nie dostaje uprawnienia ani statusu zatwierdzenia. |
| `done/` | zakończone zadanie lub osierocony wynik | `item_id` łączy, jeśli cel istnieje; snapshot i follow-up pozostają dostępne. |
| `notes/<ID>/note.json` | notatka/pamięć historyczna | Dowolny typ `body`, dodatkowe pola i oryginalny payload są zachowane; domyślnie propozycja. |
| odkryte pliki notatki | załącznik | Ścieżka względna, rozmiar, hash i bajty; pole `files` jest wskazówką, nie źródłem prawdy. |
| `links.related_ids`, `followup_ids` | relacja lub unresolved reference | Drugi przebieg rozwiązuje tylko dokładny cel w tym samym źródle. |
| `docs/*.md`, `AGENTS.md`, `CLAUDE.md` | zewnętrzne źródło dokumentu | Repozytorium i commit pozostają źródłem prawdy; treść nie staje się instrukcją. |
| config i override'y schematów | metadane źródła/importu | Reguły są archiwizowane, ale nie są wykonywalną konfiguracją kontrolera. |
| `index.json`, HTML i cache | pominięte dane pochodne | Raportuje się pominięcie; nie są źródłem rekordów. |

## Pola nierozstrzygnięte przed K2/K6

- Ostateczne nazwy tabel i publicznych DTO; semantyka powyżej jest wiążąca.
- Dopuszczalny słownik typów relacji poza minimalnymi
  `derived_from`, `blocks`, `relates_to`, `supersedes`.
- Maksymalny rozmiar pojedynczego załącznika, projektu i partii importu — K5
  ustali je na podstawie fixture oraz polityki zasobów.
- Retencja historii i kluczy idempotencji. Pierwsze wydanie nie może usuwać
  ich automatycznie przed zdefiniowaniem bezpiecznego eksportu/backup.
- Mapowanie niestandardowych stanów i pól z override'ów: zawsze zachować
  payload, a nieznaną semantykę oznaczyć jako `source_only`.
- Tożsamość repozytorium po zmianie remote. K6 wymaga jawnego `source_id` i nie
  może polegać wyłącznie na aktualnym URL.

## Scenariusze negatywne

1. Usunięcie runtime odłącza mapowanie, lecz liczby, rewizje i historia wiedzy
   pozostają niezmienione. Ponowna rejestracja nie podłącza ich sama.
2. Drugi kontroler i offline CLI nie otwierają bazy bez singleton lock.
3. Lista i szczegóły wiedzy nie wywołują `git worktree list`, `git status` ani
   skanu dokumentów; jawne odświeżenie/import są osobnymi operacjami.
4. Agent projektu A nie poznaje ID projektu B przez listę, błąd, eksport,
   załącznik ani SSE. Cofnięty grant blokuje też replay idempotencji.
5. `human:owner` przesłane jako nazwa autora nie daje zatwierdzenia.
6. Nieaktualna `expectedRevision` i ponowiony klucz z innym payloadem nie
   zmieniają danych.
7. Relacja między projektami, traversal/symlink załącznika, rozbieżny hash,
   nieobsługiwany override i brak deklarowanego pliku kończą plan/import
   stabilnym błędem lub jawnym blokującym raportem.
8. `index.json` bez rekordu obecnego w `done/` nie powoduje utraty archiwum.
9. Przerwany import nie publikuje części partii; osierocony obiekt pliku nie
   ma widocznej referencji.

## Bramka K0

K0 pozwala rozpocząć K1 po przejściu walidacji fixture i zapisaniu bazowych
wyników testów. Nie pozwala udostępnić zapisu prawdziwej wiedzy. K2 pozostaje
zablokowane do czasu wdrożenia trwałego principal i semantyki odłączenia z K1.
