#!/bin/bash
API_URL="https://10.97.0.2:8443/api/items"
RAND_IP="10.88.$((RANDOM % 250)).$((RANDOM % 250))"

echo "================================================================="
echo "1. KIEM THU TRUY CAP HTTPS QUA HAPROXY (MODE TCP) & INGRESS TLS"
echo "================================================================="
curl -k -I https://10.97.0.2:8443/

echo "================================================================="
echo "2. KIEM THU AUTHENTICATION & PHAN QUYEN RBAC (USER VS ADMIN)"
echo "================================================================="
echo "[2.1] Khong truyen xac thuc (Anonymous):"
curl -k -s -H "X-Forwarded-For: $RAND_IP" -w "  -> HTTP Status: %{http_code}\n" $API_URL

echo "[2.2] Role = user (Basic Auth -u user:user123):"
curl -k -s -H "X-Forwarded-For: $RAND_IP" -u user:user123 -w "  + GET    -> HTTP Status: %{http_code}\n" -o /dev/null $API_URL
curl -k -s -H "X-Forwarded-For: $RAND_IP" -u user:user123 -X POST -H "Content-Type: application/json" -d '{"name":"UserPost"}' -w "  + POST   -> HTTP Status: %{http_code} | Body: " $API_URL; echo ""
curl -k -s -H "X-Forwarded-For: $RAND_IP" -u user:user123 -X DELETE -w "  + DELETE -> HTTP Status: %{http_code} | Body: " $API_URL; echo ""

echo "[2.3] Role = admin (Basic Auth -u admin:admin123):"
curl -k -s -H "X-Forwarded-For: $RAND_IP" -u admin:admin123 -w "  + GET    -> HTTP Status: %{http_code}\n" -o /dev/null $API_URL
curl -k -s -H "X-Forwarded-For: $RAND_IP" -u admin:admin123 -X POST -H "Content-Type: application/json" -d '{"name":"AdminItem"}' -w "  + POST   -> HTTP Status: %{http_code}\n" $API_URL
curl -k -s -H "X-Forwarded-For: $RAND_IP" -u admin:admin123 -X DELETE -w "  + DELETE -> HTTP Status: %{http_code}\n" $API_URL

echo ""
echo "================================================================="
echo "3. KIEM THU RATE LIMITING (> 10 REQUESTS/PHUT -> HTTP 409)"
echo "================================================================="
RL_IP="10.99.$((RANDOM % 250)).$((RANDOM % 250))"
for i in $(seq 1 12); do
  RES=$(curl -k -s -w "|%{http_code}" -H "X-Forwarded-For: $RL_IP" -u user:user123 $API_URL)
  BODY=$(echo "$RES" | cut -d'|' -f1)
  CODE=$(echo "$RES" | cut -d'|' -f2)
  if [ "$CODE" = "200" ]; then
    echo "Request #$i -> HTTP Status: 200 OK"
  else
    echo "Request #$i -> HTTP Status: $CODE | $BODY"
  fi
done
