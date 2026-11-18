#!/usr/bin/env bash
# setup-cloud.sh — installe et configure OpenJarvis (+ Ollama et un modèle local)
# dans un conteneur Linux, y compris en root et sans accès aux releases GitHub.
#
# L'installeur officiel (curl … install.sh | bash) refuse de tourner en root et
# télécharge Ollama depuis les releases GitHub. Ce script reproduit les mêmes
# étapes, mais compile Ollama depuis ses sources officielles si besoin.
#
# Idempotent : relancez-le autant de fois que nécessaire, les étapes déjà
# faites sont sautées.
#
# Variables utiles :
#   OPENJARVIS_HOME   dossier d'installation (défaut : ~/.openjarvis)
#   JARVIS_MODEL      modèle Ollama à télécharger (défaut : qwen3.5:2b)
#   SKIP_MODEL=1      ne pas télécharger de modèle
#   SKIP_RUST=1       ne pas compiler l'extension Rust (mémoire / sécurité)

set -euo pipefail

OJ_HOME="${OPENJARVIS_HOME:-$HOME/.openjarvis}"
MODEL="${JARVIS_MODEL:-qwen3.5:2b}"
OLLAMA_SRC="${OLLAMA_SRC:-$HOME/.cache/openjarvis/ollama-src}"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/go/bin:/usr/local/bin:$PATH"

log() { printf '\n==> %s\n' "$*"; }

# Dans les conteneurs Claude Code, les registres de paquets figurent dans
# NO_PROXY ; on les fait passer par le proxy, qui les autorise.
if [[ -n "${HTTPS_PROXY:-}" && -n "${NO_PROXY:-}" ]]; then
    NO_PROXY="$(printf '%s' "$NO_PROXY" | tr ',' '\n' \
        | grep -vxE 'pypi.org|files.pythonhosted.org|registry.npmjs.org|proxy.golang.org|index.crates.io' \
        | paste -sd, -)"
    export NO_PROXY no_proxy="$NO_PROXY"
fi

if ! command -v uv >/dev/null; then
    log "Installation de uv"
    python3 -m pip install --user --break-system-packages uv \
        || curl -LsSf https://astral.sh/uv/install.sh | sh
fi

# ---- 1. OpenJarvis --------------------------------------------------------
log "OpenJarvis : sources"
mkdir -p "$OJ_HOME/.state" "$OJ_HOME/.scripts" "$HOME/.local/bin"
if [[ ! -d "$OJ_HOME/src/.git" ]]; then
    git clone --filter=blob:none https://github.com/open-jarvis/OpenJarvis.git "$OJ_HOME/src"
fi

log "OpenJarvis : environnement Python"
[[ -x "$OJ_HOME/.venv/bin/python" ]] || uv venv --python 3.13 "$OJ_HOME/.venv"
(cd "$OJ_HOME/src" && uv pip install --python "$OJ_HOME/.venv/bin/python" -e ".[server]")

cp -f "$OJ_HOME"/src/scripts/install/*.sh "$OJ_HOME/.scripts/"
chmod +x "$OJ_HOME"/.scripts/*.sh
ln -sf "$OJ_HOME/.scripts/jarvis-wrapper.sh" "$HOME/.local/bin/jarvis"
ln -sf "$OJ_HOME/.scripts/jarvis-uninstall.sh" "$HOME/.local/bin/jarvis-uninstall"
grep -q "OpenJarvis" "$HOME/.bashrc" 2>/dev/null \
    || printf '\n# OpenJarvis\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"

# ---- 2. Ollama --------------------------------------------------------------
if ! command -v ollama >/dev/null || [[ "${FORCE_OLLAMA_BUILD:-0}" == 1 ]]; then
    log "Ollama : compilation depuis les sources (CPU, ~5-10 min)"
    [[ -d "$OLLAMA_SRC/.git" ]] || git clone --depth 1 https://github.com/ollama/ollama "$OLLAMA_SRC"
    cmake -S "$OLLAMA_SRC" -B "$OLLAMA_SRC/build"
    cmake --build "$OLLAMA_SRC/build" --parallel "$(nproc)"
    cmake --install "$OLLAMA_SRC/build" --prefix /usr/local
fi

if [[ "${SKIP_MODEL:-0}" != 1 ]]; then
    log "Ollama : modèle $MODEL"
    TEMP_OLLAMA=""
    if ! ollama list >/dev/null 2>&1; then
        ollama serve > "$OJ_HOME/.state/ollama.log" 2>&1 &
        TEMP_OLLAMA=$!
        for _ in $(seq 60); do ollama list >/dev/null 2>&1 && break; sleep 1; done
    fi
    ollama pull "$MODEL"
    # Serveur lancé seulement pour le téléchargement : on l'arrête (start.sh le relance).
    if [[ -n "$TEMP_OLLAMA" ]]; then kill "$TEMP_OLLAMA"; wait "$TEMP_OLLAMA" 2>/dev/null || true; fi
fi

# ---- 3. Configuration -------------------------------------------------------
if [[ ! -f "$OJ_HOME/config.toml" ]]; then
    log "OpenJarvis : config.toml"
    "$OJ_HOME/.venv/bin/jarvis" _bootstrap --write-config \
        --engine ollama --model "$MODEL" --prefer-cloud-when-available
    "$OJ_HOME/.venv/bin/jarvis" config set analytics.enabled false >/dev/null
    "$OJ_HOME/.venv/bin/jarvis" config set security.profile personal >/dev/null
fi

# ---- 4. Interface web (jarvis gui) : Node 22 + npm 11 requis -----------------
if command -v npm >/dev/null && [[ ! -d "$OJ_HOME/src/frontend/node_modules" ]]; then
    log "OpenJarvis : dépendances de l'interface web"
    unset npm_config_noproxy
    [[ "$(npm --version | cut -d. -f1)" -ge 11 ]] || npm install -g npm@11.19.0
    (cd "$OJ_HOME/src/frontend" && npm ci --no-audit --no-fund)
fi

# ---- 5. Extension Rust (facultative) ------------------------------------------
if [[ "${SKIP_RUST:-0}" != 1 && ! -f "$OJ_HOME/.state/extension-built" ]]; then
    log "OpenJarvis : extension Rust (mémoire + sécurité)"
    "$OJ_HOME/.scripts/build-extension.sh" \
        || echo "   (échec non bloquant, voir $OJ_HOME/.state/extension-build.log)"
fi

log "Installation terminée. Démarrez les services avec : scripts/start.sh --gui"
