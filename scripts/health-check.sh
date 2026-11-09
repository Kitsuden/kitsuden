#!/bin/bash
# ===================================================================
# Kitsuden - Health Check Script
# ===================================================================
# Usage:
#   ./scripts/health-check.sh
#   ./scripts/health-check.sh --watch   (continuous monitoring)
# ===================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

API_URL="${API_URL:-http://localhost:3000}"
ADMIN_URL="${ADMIN_URL:-http://localhost:3001}"
WATCH_MODE=0

if [ "$1" = "--watch" ] || [ "$1" = "-w" ]; then
    WATCH_MODE=1
fi

check_endpoint() {
    local name="$1"
    local url="$2"
    local expected="${3:-200}"
    
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
    
    if [ "$status" = "$expected" ]; then
        echo -e "${GREEN}✅ $name${NC} — HTTP $status"
        return 0
    else
        echo -e "${RED}❌ $name${NC} — HTTP $status (expected: $expected)"
        return 1
    fi
}

check_all() {
    echo -e "${BOLD}${CYAN}🏥 Health Check — $(date)${NC}\n"
    
    local failures=0
    
    # API Health
    if ! check_endpoint "API Health" "$API_URL/api/health"; then
        failures=$((failures + 1))
    fi
    
    # API Swagger
    if ! check_endpoint "API Swagger" "$API_URL/api/swagger"; then
        failures=$((failures + 1))
    fi
    
    # Admin Panel
    if ! check_endpoint "Admin Panel" "$ADMIN_URL/" "200"; then
        # nginx may return 301/302 for redirects
        local admin_status
        admin_status=$(curl -s -o /dev/null -w "%{http_code}" "$ADMIN_URL/" 2>/dev/null || echo "000")
        if [ "$admin_status" = "301" ] || [ "$admin_status" = "302" ]; then
            echo -e "${YELLOW}⚠️  Admin Panel${NC} — HTTP $admin_status (redirect, probably OK)"
            failures=$((failures - 1))
        fi
    fi
    
    # Check that the containers are running
    echo ""
    echo -e "${BOLD}Containers:${NC}"
    
    local instance="${KITSUDEN_INSTANCE:-kitsuden}"
    local containers=("${instance}_api_prod" "${instance}_db_prod" "${instance}_state_prod" "${instance}_admin_prod")
    for container in "${containers[@]}"; do
        if docker ps --format "{{.Names}}" | grep -q "^${container}$"; then
            local uptime
            uptime=$(docker inspect -f "{{.State.Status}}" "$container" 2>/dev/null || echo "unknown")
            echo -e "  ${GREEN}●${NC} $container ($uptime)"
        else
            echo -e "  ${RED}●${NC} $container ${RED}(NOT RUNNING)${NC}"
            failures=$((failures + 1))
        fi
    done
    
    # Summary
    echo ""
    if [ $failures -eq 0 ]; then
        echo -e "${GREEN}${BOLD}✅ All healthy${NC}"
    else
        echo -e "${RED}${BOLD}❌ $failures problem(s) found${NC}"
        echo -e "   Check the logs: docker compose logs -f kitsuden_api"
    fi
    
    return $failures
}

# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

if [ $WATCH_MODE -eq 1 ]; then
    echo -e "${CYAN}Watch mode on (Ctrl+C to exit)${NC}\n"
    while true; do
        clear
        check_all
        echo -e "\n${YELLOW}Refreshing every 10 seconds...${NC}"
        sleep 10
    done
else
    check_all
    exit $?
fi
