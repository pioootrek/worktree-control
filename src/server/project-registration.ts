import { resolve } from "node:path";

import type { Worktree } from "@/shared/contracts";
import type { GitWorktreeReader } from "./git-worktrees";

export async function discoverProjectRegistrationTarget(
  git: Pick<GitWorktreeReader, "canonicalRepositoryPath" | "list">,
  inputPath: string,
): Promise<{ repositoryPath: string; selectedWorktree: Worktree }> {
  const repositoryPath = await git.canonicalRepositoryPath(resolve(inputPath));
  const [selectedWorktree] = await git.list(repositoryPath);
  if (!selectedWorktree) throw new Error("Repozytorium nie ma dostępnego worktree.");
  return { repositoryPath, selectedWorktree };
}
