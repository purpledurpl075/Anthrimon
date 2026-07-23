// Package crypto provides AES-256-GCM encryption/decryption for credential
// data. The same scheme is used by the Python FastAPI backend so both services
// can read each other's encrypted records.
//
// Wire format: base64url(nonce_12bytes || ciphertext+tag_bytes)
// Key source:  ANTHRIMON_ENCRYPTION_KEY env var (64 hex chars = 32 bytes)
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
)

var (
	ErrNoKey      = errors.New("encryption key not configured")
	ErrKeyLength  = errors.New("encryption key must be 32 bytes (64 hex chars)")
	ErrDecrypt    = errors.New("decryption failed: invalid ciphertext or wrong key")
)

// AESCodec encrypts and decrypts using AES-256-GCM.
type AESCodec struct {
	key []byte // 32 bytes
}

// NewAESCodec creates a codec from a 64-character hex key string.
// Returns ErrNoKey if keyHex is empty (plaintext mode — no encryption).
// Returns ErrKeyLength if the key is present but not exactly 64 hex chars.
func NewAESCodec(keyHex string) (*AESCodec, error) {
	if keyHex == "" {
		return nil, ErrNoKey
	}
	key, err := hex.DecodeString(keyHex)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrKeyLength, err)
	}
	if len(key) != 32 {
		return nil, ErrKeyLength
	}
	return &AESCodec{key: key}, nil
}

// Encrypt encrypts plaintext and returns the base64url-encoded ciphertext
// (nonce prepended). Each call generates a fresh random nonce.
func (c *AESCodec) Encrypt(plaintext []byte) (string, error) {
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return "", fmt.Errorf("creating AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize()) // 12 bytes
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generating nonce: %w", err)
	}

	sealed := gcm.Seal(nonce, nonce, plaintext, nil) // nonce + ciphertext + tag
	return base64.URLEncoding.EncodeToString(sealed), nil
}

// Decrypt decodes a base64url ciphertext produced by Encrypt and returns
// the original plaintext.
func (c *AESCodec) Decrypt(ciphertextB64 string) ([]byte, error) {
	data, err := base64.URLEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return nil, fmt.Errorf("%w: base64 decode: %v", ErrDecrypt, err)
	}

	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, fmt.Errorf("creating AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("creating GCM: %w", err)
	}

	ns := gcm.NonceSize()
	if len(data) < ns {
		return nil, ErrDecrypt
	}

	plaintext, err := gcm.Open(nil, data[:ns], data[ns:], nil)
	if err != nil {
		return nil, ErrDecrypt
	}
	return plaintext, nil
}
