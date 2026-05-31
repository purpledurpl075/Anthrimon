# Syslog — Ubiquiti

The syslog collector listens on **UDP port 514**.

## UniFi Network (via Network Application)

Go to **Settings** → **System** → **Advanced** → **Remote Logging** and enter the hub IP and port 514.

## EdgeOS (EdgeRouter)

```
set system syslog host <hub-ip> facility all level info
commit
save
```

## Verify on EdgeOS

```
show log
```

## AirOS (airMAX, airFiber)

Go to **System** → **Syslog** and enter the hub IP and port 514.

## Notes

- Ubiquiti devices use UDP syslog in RFC 3164 format
- The source IP is the outbound interface — confirm it matches the management IP registered in the system
