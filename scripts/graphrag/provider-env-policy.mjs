function hasEnvValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function providerSourceForDotenvSelection(input) {
  const {
    currentValue,
    graphVaultHasValue,
    graphVaultValue,
    initialEnvHadKey,
    projectHasValue,
    projectValue,
    selectedLayer,
  } = input;
  const currentMatchesGraphVault =
    graphVaultHasValue && currentValue === graphVaultValue;
  const currentMatchesProject = projectHasValue && currentValue === projectValue;
  const projectMatchesGraphVault =
    projectHasValue && graphVaultHasValue && projectValue === graphVaultValue;

  if (selectedLayer === "graph_vault_dotenv") {
    if (initialEnvHadKey && !currentMatchesGraphVault) {
      return "graph_vault_dotenv_overrides_shell_env";
    }
    if (initialEnvHadKey && currentMatchesGraphVault) {
      return "process_env_matches_graph_vault_dotenv";
    }
    if (projectMatchesGraphVault) return "project_and_graph_vault_dotenv";
    if (projectHasValue) return "graph_vault_dotenv_shadows_project_dotenv";
    return "graph_vault_dotenv";
  }

  if (selectedLayer === "project_dotenv") {
    if (initialEnvHadKey && !currentMatchesProject) {
      return "project_dotenv_overrides_shell_env";
    }
    if (initialEnvHadKey && currentMatchesProject) {
      return "process_env_matches_project_dotenv";
    }
    return "project_dotenv";
  }

  return initialEnvHadKey ? "process_env" : "missing";
}

export function selectProviderRuntimeEnv(input) {
  const {
    env,
    graphVaultEnv = {},
    initialEnvNames = new Set(),
    observedEnvNames = [],
    projectEnv = {},
  } = input;
  const envPatch = {};
  const sources = {};
  const names = [...new Set(observedEnvNames)].sort();

  for (const key of names) {
    const currentValue = env[key];
    const projectValue = projectEnv[key];
    const graphVaultValue = graphVaultEnv[key];
    const projectHasValue = hasEnvValue(projectValue);
    const graphVaultHasValue = hasEnvValue(graphVaultValue);
    const initialEnvHadKey = initialEnvNames.has(key);

    if (graphVaultHasValue) {
      envPatch[key] = graphVaultValue;
      sources[key] = providerSourceForDotenvSelection({
        currentValue,
        graphVaultHasValue,
        graphVaultValue,
        initialEnvHadKey,
        projectHasValue,
        projectValue,
        selectedLayer: "graph_vault_dotenv",
      });
      continue;
    }

    if (projectHasValue) {
      envPatch[key] = projectValue;
      sources[key] = providerSourceForDotenvSelection({
        currentValue,
        graphVaultHasValue,
        graphVaultValue,
        initialEnvHadKey,
        projectHasValue,
        projectValue,
        selectedLayer: "project_dotenv",
      });
      continue;
    }

    if (hasEnvValue(currentValue)) {
      sources[key] = "process_env";
    }
  }

  return { envPatch, sources };
}
