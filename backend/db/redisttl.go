package db

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"mini-tools/backend/i18n"
)

// TTL management for a key, split out from rediskeys.go so the expiry
// operations sit together rather than being scattered among the value
// readers.
//
// Redis has no single "set the TTL" command: EXPIRE sets one, PERSIST
// removes one, and the difference matters — a key with no expiry and a key
// that expires in a second are the same command away from each other, and
// getting it backwards silently makes data either permanent or temporary.
// The two operations are therefore separate bindings, never one call with a
// magic sentinel value.

// SetRedisKeyTTL gives key an expiry of seconds from now.
//
// Rejects a non-positive value instead of forwarding it: Redis treats
// EXPIRE with 0 or a negative TTL as "delete the key immediately", which is
// a destructive surprise for someone who typed a 0 into a TTL box meaning
// "no expiry". Removing an expiry is PersistRedisKey's job, explicitly.
func SetRedisKeyTTL(ctx context.Context, client redis.UniversalClient, key string, seconds int64) error {
	if seconds <= 0 {
		return i18n.Errorf(i18n.Msg{ES: "db: un TTL de %d segundos borraría la clave; usá PERSIST para quitar el vencimiento", EN: "db: a TTL of %d seconds would delete the key; use PERSIST to remove the expiry"}, seconds)
	}

	ok, err := client.Expire(ctx, key, time.Duration(seconds)*time.Second).Result()
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "db: EXPIRE de %q: %w", EN: "db: EXPIRE of %q: %w"}, key, err)
	}
	if !ok {
		// EXPIRE returns 0 when the key does not exist — which, in a
		// browser, most often means it expired between the listing and the
		// click. Saying so beats a silent no-op.
		return i18n.Errorf(i18n.Msg{ES: "db: la clave %q ya no existe (¿venció?)", EN: "db: key %q no longer exists (did it expire?)"}, key)
	}
	return nil
}

// PersistRedisKey removes key's expiry, making it permanent.
//
// A false return from PERSIST means either "the key is gone" or "it had no
// expiry to begin with". The second is not a failure — asking a permanent
// key to be permanent is a no-op the user should not see an error for — so
// the two are told apart with an EXISTS check rather than reported alike.
func PersistRedisKey(ctx context.Context, client redis.UniversalClient, key string) error {
	changed, err := client.Persist(ctx, key).Result()
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "db: PERSIST de %q: %w", EN: "db: PERSIST of %q: %w"}, key, err)
	}
	if changed {
		return nil
	}

	exists, err := client.Exists(ctx, key).Result()
	if err != nil {
		return i18n.Errorf(i18n.Msg{ES: "db: EXISTS de %q: %w", EN: "db: EXISTS of %q: %w"}, key, err)
	}
	if exists == 0 {
		return i18n.Errorf(i18n.Msg{ES: "db: la clave %q ya no existe (¿venció?)", EN: "db: key %q no longer exists (did it expire?)"}, key)
	}
	return nil // Already persistent.
}
