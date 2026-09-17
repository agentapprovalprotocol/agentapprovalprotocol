package hook

import (
	"context"
	"github.com/agentapprovalprotocol/agentapprovalprotocol/internal/aap"
	"time"
)

const requestTimeout = 5 * time.Minute

func gate(ctx context.Context, client *aap.Client, in aap.CreateInput) (aap.Decision, error) {
	return client.Decide(ctx, in)
}
