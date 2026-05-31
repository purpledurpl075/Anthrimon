# Changing the Database Password

## 1. Update PostgreSQL

```bash
PGPASSWORD=<current_password> psql -U anthrimon -h 127.0.0.1 -d anthrimon \
  -c "ALTER USER anthrimon WITH PASSWORD '<new_password>';"
```

## 2. Update the API service

Edit `/etc/systemd/system/anthrimon-api.service` and update:

```
Environment="DB_PASSWORD=<new_password>"
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart anthrimon-api
```

## 3. Update all collector configs

Each collector has a DSN in its YAML config. Special characters in the password must be URL-encoded:

| Character | Encoded |
|-----------|---------|
| `$`       | `%24`   |
| `%`       | `%25`   |
| `^`       | `%5E`   |
| `@`       | `%40`   |
| `#`       | `%23`   |

Edit the `dsn` line in each file:

- `/home/poly/Anthri-mon/collectors/snmp/snmp-collector.yaml`
- `/home/poly/Anthri-mon/collectors/flow/flow-collector.yaml`
- `/home/poly/Anthri-mon/collectors/syslog/syslog-collector.yaml`

```yaml
database:
  dsn: "postgres://anthrimon:<url-encoded-password>@127.0.0.1/anthrimon?sslmode=disable"
```

Then restart all collectors:

```bash
sudo systemctl restart snmp-collector flow-collector syslog-collector
```

## 4. Verify

Check each service is running without auth errors:

```bash
sudo systemctl status anthrimon-api snmp-collector flow-collector syslog-collector
journalctl -u snmp-collector -n 20 --no-pager | grep -i error
```
