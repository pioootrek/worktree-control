import { describe, expect, it } from "vitest";

import { localizeServerMessage } from "./server-errors";

describe("server error localization", () => {
  it.each(["io_error", "outside_worktree", "not_regular_file", "too_large", "invalid_utf8", "invalid_json", "invalid_schema"])("translates a bounded Godot manifest reason: %s", (reason) => {
    const message = `Nie można wczytać scripts/worktree-control-presets.json (${reason}).`;
    expect(localizeServerMessage(message, "en")).toBe(`Cannot load scripts/worktree-control-presets.json (${reason}).`);
    expect(localizeServerMessage(message, "pl")).toBe(message);
  });

  it("translates a removed Godot preset", () => {
    expect(localizeServerMessage("Wybrany preset testowy Godot nie istnieje już w tym worktree.", "en"))
      .toBe("The selected Godot test preset no longer exists in this worktree.");
  });

  it("keeps Polish errors unchanged", () => {
    expect(localizeServerMessage("Nie znaleziono projektu.", "pl")).toBe("Nie znaleziono projektu.");
  });

  it("translates known and parameterized errors", () => {
    expect(localizeServerMessage("Nie znaleziono projektu.", "en")).toBe("Project not found.");
    expect(localizeServerMessage("Projekt jest zablokowany przez agent:test.", "en"))
      .toBe("The project is locked by agent:test.");
    expect(localizeServerMessage("Wskaż plik: klucz prywatny.", "en"))
      .toBe("Select the private key file.");
    expect(localizeServerMessage("Nie znaleziono manage.py w katalogu głównym worktree.", "en"))
      .toBe("manage.py was not found at the worktree root.");
    expect(localizeServerMessage("Projekt Angular nie ma skryptu dev ani start uruchamiającego ng serve.", "en"))
      .toBe("The Angular project has no dev or start script that runs ng serve.");
    expect(localizeServerMessage("Osiągnięto limit 2 uruchomionych serwerów. Aktywne: Web, API.", "en"))
      .toBe("The limit of 2 running servers has been reached. Active: Web, API.");
    expect(localizeServerMessage("Zatrzymaj serwer przed zmianą zmiennych środowiskowych.", "en"))
      .toBe("Stop the server before changing environment variables.");
    expect(localizeServerMessage("Nie znaleziono profilu środowiska.", "en"))
      .toBe("Environment profile not found.");
    expect(localizeServerMessage("Profilu default nie można usunąć.", "en"))
      .toBe("The default profile cannot be deleted.");
    expect(localizeServerMessage("Zmienna PORT jest zarządzana przez kontroler.", "en"))
      .toBe("The PORT variable is managed by the controller.");
    expect(localizeServerMessage("Limit równoległych testów musi być liczbą całkowitą od 1 do 16.", "en"))
      .toBe("The parallel test limit must be an integer from 1 to 16.");
    expect(localizeServerMessage("Nie znaleziono uruchomienia testu.", "en"))
      .toBe("Test run not found.");
    expect(localizeServerMessage("Kolejka poleceń Git jest zajęta. Spróbuj ponownie później.", "en"))
      .toBe("The Git command queue is busy. Try again later.");
    expect(localizeServerMessage("Pamięć projekcji panelu jest zajęta. Spróbuj ponownie później.", "en"))
      .toBe("The dashboard projection cache is busy. Try again later.");
    expect(localizeServerMessage("Kontroler jest zamykany i nie przyjmuje nowych operacji.", "en"))
      .toBe("The controller is shutting down and is not accepting new operations.");
    expect(localizeServerMessage("Metadane worktree przekraczają limit projekcji panelu.", "en"))
      .toBe("The worktree metadata exceeds the dashboard projection limit.");
    expect(localizeServerMessage("Nie udało się potwierdzić stanu co najmniej jednego worktree. Przyjęto bezpiecznie, że zawiera zmiany.", "en"))
      .toBe("The status of at least one worktree could not be confirmed. It is conservatively treated as having changes.");
  });
});
