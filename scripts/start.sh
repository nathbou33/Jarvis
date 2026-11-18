#!/usr/bin/env bash
# start.sh — démarre ce dont OpenJarvis a besoin (à relancer après chaque
# redémarrage du conteneur) :
#   - le serveur Ollama (moteur local, port 11434)
#   - l'API OpenJarvis compatible OpenAI (port 8000)
#   - avec --gui : l'interface web (port 5173)
# Chaque service déjà en marche est laissé tel quel.

set -euo pipefail

OJ_HOME="${OPENJARVIS_HOME:-$HOME/.openjarvis}"
API_PORT="${JARVIS_API_PORT:-8000}"
GUI_PORT="${JARVIS_GUI_PORT:-5173}"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
mkdir -p "$OJ_HOME/.state"

wait_for() {  # wait_for <commande…> : réessaie jusqu'à 60 s
    for _ in $(seq 60); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
    return 1
}

if ! ollama list >/dev/null 2>&1; then
    nohup ollama serve > "$OJ_HOME/.state/ollama.log" 2>&1 &
    wait_for ollama list || { echo "Ollama ne répond pas, voir $OJ_HOME/.state/ollama.log" >&2; exit 1; }
fi
echo "Ollama        : OK ($(ollama list | tail -n +2 | awk '{print $1}' | paste -sd' ' -))"

if ! curl -fs "http://127.0.0.1:$API_PORT/health" >/dev/null; then
    jarvis start --port "$API_PORT" >/dev/null
    wait_for curl -fs "http://127.0.0.1:$API_PORT/health" \
        || { echo "L'API ne répond pas, voir $OJ_HOME/server.log" >&2; exit 1; }
fi
echo "API           : http://127.0.0.1:$API_PORT"

if [[ "${1:-}" == "--gui" ]]; then
    if ! curl -fs -o /dev/null "http://127.0.0.1:$GUI_PORT"; then
        (cd "$HOME" && nohup jarvis gui --no-browser --frontend-port "$GUI_PORT" \
            --api-port "$API_PORT" > "$OJ_HOME/.state/gui.log" 2>&1 &)
        wait_for curl -fs -o /dev/null "http://127.0.0.1:$GUI_PORT" \
            || { echo "L'interface ne répond pas, voir $OJ_HOME/.state/gui.log" >&2; exit 1; }
    fi
    echo "Interface web : http://127.0.0.1:$GUI_PORT"
fi
