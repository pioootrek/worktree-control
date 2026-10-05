import type { Project, RuntimeFailure } from "@/shared/contracts";

function exitDetails(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `signal=${signal}`;
  return `exit_code=${code ?? "unknown"}`;
}

export function portInUseFailure(project: Project): RuntimeFailure {
  return {
    code: "port_in_use",
    title: `Port ${project.port} jest już używany`,
    message: "Na tym porcie działa inny serwer. Worktree Control pozostawił go bez zmian.",
    suggestion: "Zatrzymaj tamten serwer albo ustaw dla projektu inny port. Serwer zarządzany przez systemd trzeba podłączyć do Worktree Control zamiast uruchamiać drugi proces.",
    technicalDetails: `tcp_port=${project.port} status=occupied launch=skipped`,
  };
}

export function spawnFailure(project: Project, error: NodeJS.ErrnoException): RuntimeFailure {
  if (error.code === "ENOENT") {
    return {
      code: "missing_executable",
      title: `Nie znaleziono programu ${project.executable}`,
      message: "Kontroler nie może uruchomić skonfigurowanej komendy.",
      suggestion: `Sprawdź, czy ${project.executable} jest zainstalowany i dostępny w PATH kontrolera.`,
      technicalDetails: error.message,
    };
  }
  return {
    code: "process_exit",
    title: "Nie udało się uruchomić procesu",
    message: "System odrzucił próbę uruchomienia serwera deweloperskiego.",
    suggestion: "Sprawdź uprawnienia katalogu i konfigurację komendy.",
    technicalDetails: error.message,
  };
}

export function timeoutFailure(project: Project): RuntimeFailure {
  return {
    code: "startup_timeout",
    title: "Serwer nie zgłosił gotowości",
    message: `Proces działał, ale nie odpowiedział na porcie ${project.port} w ciągu ${project.startupTimeoutMs / 1000} sekund.`,
    suggestion: "Sprawdź Logi. Aplikacja mogła wystartować na innym porcie, używać HTTPS albo potrzebować więcej czasu.",
    technicalDetails: `startup_timeout_ms=${project.startupTimeoutMs} healthcheck_path=${project.healthcheckPath}`,
  };
}

export function processExitFailure(
  project: Project,
  logs: string[],
  code: number | null,
  signal: NodeJS.Signals | null,
): RuntimeFailure {
  const text = logs.join("\n").replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  const technicalDetails = exitDetails(code, signal);

  if (/EADDRINUSE|address already in use|port .*already in use/i.test(text)) {
    return { ...portInUseFailure(project), technicalDetails: `${technicalDetails} reason=address_in_use` };
  }
  if (/ERR_PNPM_NO_SCRIPT|missing script[^\n]*dev|command ["']?dev["']? not found/i.test(text)) {
    return {
      code: "missing_dev_script",
      title: "Projekt nie ma komendy dev",
      message: "W pliku package.json nie znaleziono skryptu potrzebnego do uruchomienia serwera.",
      suggestion: "Dodaj skrypt dev do package.json albo wybierz inny preset komendy dla tego projektu.",
      technicalDetails,
    };
  }
  if (/No module named ["']django["']|Couldn't import Django/i.test(text)) {
    return {
      code: "missing_dependency",
      title: "Nie znaleziono Django",
      message: "Wybrany interpreter Python nie ma zainstalowanego Django.",
      suggestion: "Utwórz .venv lub venv w tym worktree i zainstaluj zależności projektu.",
      technicalDetails,
    };
  }
  if (/unknown (option|argument)|unrecognized option|unexpected argument[^\n]*port|invalid project directory[^\n]*--port/i.test(text)) {
    return {
      code: "invalid_arguments",
      title: "Projekt nie przyjmuje skonfigurowanych argumentów",
      message: "Komenda deweloperska odrzuciła argument z numerem portu.",
      suggestion: "Zmień preset komendy projektu tak, aby przekazywał port w formacie obsługiwanym przez aplikację.",
      technicalDetails,
    };
  }
  if (/heap out of memory|allocation failed|out of memory|\boom\b/i.test(text) || signal === "SIGKILL") {
    return {
      code: "resource_limit",
      title: "Proces został zatrzymany przez system",
      message: "Serwer prawdopodobnie przekroczył dostępny limit pamięci lub został przymusowo zakończony.",
      suggestion: "Sprawdź limity usługi i ostatnie wpisy w Logach przed ponownym uruchomieniem.",
      technicalDetails,
    };
  }
  return {
    code: "process_exit",
    title: "Serwer nie wystartował",
    message: "Komenda deweloperska zakończyła się, zanim aplikacja zgłosiła gotowość.",
    suggestion: "Otwórz Logi i sprawdź ostatni wpis. Najczęściej wskazuje brakującą zależność albo błąd konfiguracji projektu.",
    technicalDetails,
  };
}
