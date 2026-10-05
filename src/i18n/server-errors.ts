import type { Locale } from "./messages";

const exactEnglish = new Map<string, string>([
  ["Nazwa projektu jest wymagana.", "Project name is required."],
  ["Właściciel został już zainicjalizowany.", "The owner has already been initialized."],
  ["Port musi być liczbą od 1024 do 65535.", "Port must be an integer between 1024 and 65535."],
  ["Repozytorium nie ma dostępnego worktree.", "The repository has no available worktree."],
  ["Zatrzymaj serwer przed zmianą ustawień HTTPS.", "Stop the server before changing HTTPS settings."],
  ["Zatrzymaj serwer przed zmianą zmiennych środowiskowych.", "Stop the server before changing environment variables."],
  ["Zatrzymaj serwer lub wybierz zapis z restartem.", "Stop the server or save with restart."],
  ["Zatrzymaj serwer lub wybierz profil z restartem.", "Stop the server or select the profile with restart."],
  ["Nie znaleziono profilu środowiska.", "Environment profile not found."],
  ["Profilu default nie można usunąć.", "The default profile cannot be deleted."],
  ["Nie można usunąć aktywnego profilu środowiska.", "The active environment profile cannot be deleted."],
  ["Można ustawić maksymalnie 100 zmiennych środowiskowych.", "At most 100 environment variables can be configured."],
  ["Nieprawidłowa nazwa profilu środowiska.", "Invalid environment profile name."],
  ["Worktree nie należy do zarejestrowanego repozytorium lub już nie istnieje.", "The worktree does not belong to this repository or no longer exists."],
  ["Nie można uruchomić uszkodzonego worktree oznaczonego jako prunable.", "A damaged worktree marked as prunable cannot be started."],
  ["Nie znaleziono projektu.", "Project not found."],
  ["Serwer projektu już działa.", "The project server is already running."],
  ["Wybrana ścieżka nie jest repozytorium Git.", "The selected path is not a Git repository."],
  ["Nie wykryto obsługiwanego projektu. Oczekiwano package.json albo manage.py.", "No supported project was detected. Expected package.json or manage.py."],
  ["Repozytorium zawiera package.json i manage.py. Wybierz preset Node.js albo Django.", "The repository contains both package.json and manage.py. Select the Node.js or Django preset."],
  ["Nie znaleziono package.json w katalogu głównym worktree.", "package.json was not found at the worktree root."],
  ["Nie znaleziono manage.py w katalogu głównym worktree.", "manage.py was not found at the worktree root."],
  ["Nie udało się odczytać package.json. Sprawdź, czy plik zawiera prawidłowy JSON.", "package.json could not be read. Check that it contains valid JSON."],
  ["Projekt nie ma skryptu dev w package.json.", "The project has no dev script in package.json."],
  ["Projekt Angular nie ma skryptu dev ani start uruchamiającego ng serve.", "The Angular project has no dev or start script that runs ng serve."],
  ["HTTPS zarządzany przez Worktree Control jest obecnie obsługiwany tylko dla Next.js.", "HTTPS managed by Worktree Control currently supports Next.js only."],
  ["Nie można przeglądać katalogów poza dozwolonym katalogiem głównym.", "Directories outside the configured browser root cannot be accessed."],
  ["Brak uprawnień do odczytu tego katalogu.", "You do not have permission to read this directory."],
  ["Nie udało się odczytać katalogu.", "The directory could not be read."],
  ["Dzierżawa agenta musi trwać co najmniej 30 sekund.", "An agent lease must last at least 30 seconds."],
  ["Tylko właściciel może zdjąć tę blokadę.", "Only the owner can release this lock."],
  ["Żądanie zawiera nieobsługiwane pole.", "The request contains an unsupported field."],
  ["Nieprawidłowe pole port.", "Invalid port field."],
  ["Nieprawidłowy preset uruchomienia.", "Invalid launch preset."],
  ["Nieprawidłowa operacja.", "Invalid operation."],
  ["Nieprawidłowy tryb HTTPS.", "Invalid HTTPS mode."],
  ["Nieprawidłowa operacja blokady.", "Invalid lock operation."],
  ["Żądanie jest zbyt duże.", "The request is too large."],
  ["Nieprawidłowy JSON.", "Invalid JSON."],
  ["Brak prawidłowego klucza dostępu.", "A valid access token is required."],
  ["Odrzucono żądanie z obcego originu.", "The request origin was rejected."],
  ["Wybierz worktree do zablokowania.", "Select a worktree to lock."],
  ["Maksymalny czas dzierżawy nie może być krótszy od jej czasu początkowego.", "The maximum lease lifetime cannot be shorter than its initial TTL."],
  ["Dzierżawa agenta wymaga tokenu i klucza idempotencji.", "An agent lease requires a token and an idempotency key."],
  ["Klucz idempotencji jest już używany przez inną dzierżawę.", "The idempotency key is already used by another lease."],
  ["Dzierżawa agenta wygasła lub nie istnieje.", "The agent lease expired or does not exist."],
  ["Nieprawidłowy token dzierżawy agenta.", "The agent lease token is invalid."],
  ["Dzierżawa agenta osiągnęła maksymalny czas życia.", "The agent lease reached its maximum lifetime."],
  ["Dzierżawę agenta może zdjąć tylko jej właściciel lub człowiek przez force release.", "Only the owning agent or an explicit human force release can release this lease."],
  ["Oczekiwano obiektu JSON.", "A JSON object is required."],
  ["Nie znaleziono endpointu.", "Endpoint not found."],
  ["Proces zakończył się podczas startu.", "The process exited during startup."],
  ["Na tym porcie działa inny serwer. Worktree Control pozostawił go bez zmian.", "Another server is using this port. Worktree Control left it unchanged."],
  ["Kontroler nie może uruchomić skonfigurowanej komendy.", "The controller cannot run the configured command."],
  ["Limit serwerów musi być liczbą całkowitą od 1 do 64.", "The server limit must be an integer from 1 to 64."],
  ["Limit równoległych testów musi być liczbą całkowitą od 1 do 16.", "The parallel test limit must be an integer from 1 to 16."],
  ["Kolejka testów nie jest dostępna w tym trybie kontrolera.", "The test queue is unavailable in this controller mode."],
  ["Nie znaleziono uruchomienia testu.", "Test run not found."],
  ["Obsługa poleceń Git jest zamknięta.", "Git command handling is closed."],
  ["Obsługa poleceń Git została zamknięta.", "Git command handling was closed."],
  ["Kolejka poleceń Git jest zajęta. Spróbuj ponownie później.", "The Git command queue is busy. Try again later."],
  ["Projekcja panelu jest zamknięta.", "The dashboard projection is closed."],
  ["Kontroler jest zamykany i nie przyjmuje nowych operacji.", "The controller is shutting down and is not accepting new operations."],
  ["Metadane worktree przekraczają limit projekcji panelu.", "The worktree metadata exceeds the dashboard projection limit."],
  ["Nie udało się potwierdzić stanu co najmniej jednego worktree. Przyjęto bezpiecznie, że zawiera zmiany.", "The status of at least one worktree could not be confirmed. It is conservatively treated as having changes."],
  ["Pamięć projekcji panelu jest zajęta. Spróbuj ponownie później.", "The dashboard projection cache is busy. Try again later."],
  ["Tylko autor testu może go anulować.", "Only the test author can cancel it."],
  ["Klucz idempotencji jest już używany przez inne uruchomienie testu.", "The idempotency key is already used by another test run."],
  ["Kolejka testów może zawierać najwyżej 100 oczekujących zadań.", "The test queue can contain at most 100 waiting jobs."],
  ["Kontroler został zatrzymany przed zakończeniem testu.", "The controller stopped before the test finished."],
  ["Nieobsługiwany adapter testów.", "Unsupported test adapter."],
  ["Wybrany preset testowy Node.js nie istnieje już w tym worktree.", "The selected Node.js test preset no longer exists in this worktree."],
  ["Wybrany preset testowy Django nie istnieje już w tym worktree.", "The selected Django test preset no longer exists in this worktree."],
  ["Nie udało się odczytać package.json podczas wykrywania testów.", "package.json could not be read while discovering tests."],
  ["Anuluj testy projektu przed jego usunięciem.", "Cancel the project's tests before removing it."],
  ["Poczekaj na zakończenie testów tego worktree przed usunięciem katalogu .next.", "Wait for this worktree's tests to finish before removing its .next directory."],
  ["Nieprawidłowy katalog pamięci podręcznej.", "Invalid cache directory."],
  ["Katalog .next nie jest zwykłym katalogiem. Nie został usunięty.", "The .next path is not a regular directory and was not removed."],
  ["Zatrzymaj serwer tego worktree przed usunięciem katalogu .next.", "Stop this worktree's server before removing its .next directory."],
  ["Zwolnij blokadę tego worktree przed usunięciem katalogu .next.", "Release this worktree's lock before removing its .next directory."],
  ["Poczekaj na zakończenie pomiaru dysku przed usunięciem katalogu .next.", "Wait for the disk measurement to finish before removing the .next directory."],
  ["Worktree nie jest zwykłym katalogiem. Pamięć podręczna nie została usunięta.", "The worktree is not a regular directory. Its cache was not removed."],
  ["Ta operacja jest dostępna tylko dla projektów Next.js.", "This operation is available only for Next.js projects."],
  ["System odrzucił próbę uruchomienia serwera deweloperskiego.", "The operating system rejected the development server launch."],
  ["W pliku package.json nie znaleziono skryptu potrzebnego do uruchomienia serwera.", "No development server script was found in package.json."],
  ["Wybrany interpreter Python nie ma zainstalowanego Django.", "The selected Python interpreter does not have Django installed."],
  ["Komenda deweloperska odrzuciła argument z numerem portu.", "The development command rejected the port argument."],
  ["Serwer prawdopodobnie przekroczył dostępny limit pamięci lub został przymusowo zakończony.", "The server probably exceeded its memory limit or was forcibly terminated."],
  ["Komenda deweloperska zakończyła się, zanim aplikacja zgłosiła gotowość.", "The development command exited before the application became ready."],
]);

const fileLabels = new Map<string, string>([
  ["klucz prywatny", "private key"],
  ["certyfikat", "certificate"],
  ["CA", "CA"],
]);

export function localizeServerMessage(message: string, locale: Locale): string {
  if (locale === "pl") return message;
  const exact = exactEnglish.get(message);
  if (exact) return exact;

  let match = message.match(/^Nieprawidłowe pole (.+)\.$/);
  if (match) return `Invalid ${match[1]} field.`;
  match = message.match(/^Wskaż plik: (.+)\.$/);
  if (match) return `Select the ${fileLabels.get(match[1]) ?? match[1]} file.`;
  match = message.match(/^Nie można odczytać pliku (.+): (.+)$/);
  if (match) return `Cannot read the ${fileLabels.get(match[1]) ?? match[1]} file: ${match[2]}`;
  match = message.match(/^Projekt jest zablokowany przez (.+)\.$/);
  if (match) return `The project is locked by ${match[1]}.`;
  match = message.match(/^Projekt jest zablokowany na (.+) przez (.+)\.$/);
  if (match) return `The project is locked to ${match[1]} by ${match[2]}.`;
  match = message.match(/^Osiągnięto limit (\d+) uruchomionych serwerów\. Aktywne: (.+)\.$/);
  if (match) return `The limit of ${match[1]} running servers has been reached. Active: ${match[2]}.`;
  match = message.match(/^Nieprawidłowa nazwa zmiennej środowiskowej: (.+)\.$/);
  if (match) return `Invalid environment variable name: ${match[1]}.`;
  match = message.match(/^Zmienna (.+) jest zarządzana przez kontroler\.$/);
  if (match) return `The ${match[1]} variable is managed by the controller.`;
  match = message.match(/^Nieprawidłowa wartość zmiennej (.+)\.$/);
  if (match) return `Invalid value for environment variable ${match[1]}.`;
  match = message.match(/^Proces działał, ale nie odpowiedział na porcie (\d+) w ciągu (.+) sekund\.$/);
  if (match) return `The process did not respond on port ${match[1]} within ${match[2]} seconds.`;
  match = message.match(/^Proces testowy zakończył się z kodem (.+)\.$/);
  if (match) return `The test process exited with code ${match[1]}.`;
  return message;
}
