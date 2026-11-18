# Jarvis

Mon assistant IA personnel, basé sur [OpenJarvis](https://github.com/open-jarvis/OpenJarvis)
(Stanford) : une IA qui tourne **en local** (via [Ollama](https://ollama.com)), sans
passer par une API dans le cloud.

Ce dépôt contient de quoi l'installer et le démarrer en une commande, y compris
dans un conteneur Claude Code (environnement cloud « Jarvis »).

## Ce qui est installé

| Composant | Où | Détail |
|---|---|---|
| OpenJarvis (sources) | `~/.openjarvis/src` | dernière version de `main` |
| Environnement Python | `~/.openjarvis/.venv` | Python 3.13, avec le serveur API et l'extension Rust (mémoire + sécurité) |
| Commande `jarvis` | `~/.local/bin/jarvis` | |
| Ollama | `/usr/local/bin/ollama` | compilé depuis les sources (CPU) |
| Modèle | `qwen3.5:2b` | ~2,7 Go, modèle par défaut de l'installeur officiel |
| Configuration | `~/.openjarvis/config.toml` | moteur `ollama`, agent `simple`, statistiques d'usage **désactivées**, profil de sécurité `personal` |

## Utilisation

```bash
scripts/start.sh --gui     # démarre Ollama, l'API (port 8000) et l'interface web (port 5173)

jarvis                     # discuter dans le terminal
jarvis ask "Bonjour !"     # poser une question directement
jarvis doctor              # diagnostic de l'installation
```

L'API sur `http://127.0.0.1:8000` est compatible OpenAI (`/v1/chat/completions`) :

```bash
curl -s http://127.0.0.1:8000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.5:2b","messages":[{"role":"user","content":"Bonjour"}]}'
```

### Aller plus loin

```bash
jarvis init --preset code-assistant --force   # agent avec exécution de code, fichiers, shell
jarvis init --preset deep-research --force    # recherche dans vos documents indexés
jarvis memory index ./mes-docs/               # indexer des documents
jarvis model pull qwen3.5:4b                  # modèle plus capable (plus lent sur CPU)
```

Préréglages disponibles : `chat-simple`, `code-assistant`, `deep-research`,
`scheduled-monitor`, `morning-digest-*`. Documentation complète :
<https://open-jarvis.github.io/OpenJarvis/>.

## Réinstaller

```bash
scripts/setup-cloud.sh     # idempotent : refait uniquement les étapes manquantes
scripts/start.sh --gui
```

Options : `JARVIS_MODEL=qwen3.5:4b` (autre modèle), `SKIP_MODEL=1`, `SKIP_RUST=1`.

## Sur votre propre ordinateur

Pour un usage au quotidien, installez OpenJarvis directement sur votre machine
avec l'installeur officiel (pas besoin de ce dépôt) :

| Système | Commande |
|---|---|
| macOS · Linux · WSL2 | `curl -fsSL https://open-jarvis.github.io/OpenJarvis/install.sh \| bash` |
| Windows | `irm https://open-jarvis.github.io/OpenJarvis/install.ps1 \| iex` |
| Application de bureau | `.exe` / `.dmg` / `.deb` sur la [page des versions](https://github.com/open-jarvis/OpenJarvis/releases/latest) |

Puis `jarvis` pour démarrer. Une machine avec un GPU fera tourner des modèles
nettement plus gros et plus rapides.

## Pourquoi un script maison dans le cloud ?

L'installeur officiel refuse de tourner en `root` et télécharge Ollama depuis les
releases GitHub, deux choses impossibles dans le conteneur Claude Code.
`scripts/setup-cloud.sh` reproduit les mêmes étapes (même dossier `~/.openjarvis`,
même configuration) mais compile Ollama depuis ses sources officielles. Le réseau
de l'environnement « Jarvis » autorise pour cela les registres de paquets ainsi que
`ollama.com`, `registry.ollama.ai` et le stockage des modèles Ollama.

Le conteneur cloud est éphémère : à son redémarrage, les services sont arrêtés
(`scripts/start.sh` les relance) et, s'il est recréé, il faut réinstaller.
