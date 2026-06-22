# Adding and Managing Users

## Roles

| Role | Permissions |
|------|-------------|
| `superadmin` | Full access including user management and platform administration |
| `admin` | Full access — modify settings, manage credentials, view audit log |
| `operator` | Read/write access to devices, alerts, config |
| `readonly` | View-only access |

## Creating a user

Go to **Users** (under Admin in the sidebar) and click **New User**. Fill in username, password, and role.

Alternatively via the API:

```bash
curl -X POST https://<host>/api/v1/admin/users \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"username": "alice", "password": "...", "role": "operator"}'
```

## Resetting a password

Go to **Users**, click the user, and use **Reset Password**.

## Revoking access

Delete the user from **Users**. All active sessions for that user are invalidated immediately.

## API tokens

Users can generate long-lived API tokens from **Account** → **API Tokens**. Tokens are scoped to the user's role and tenant. Revoke them from the same page.
