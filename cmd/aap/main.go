package main

import (
	"github.com/agentapprovalprotocol/agentapprovalprotocol/cli"
	"os"
)

var version = "dev"

func main() { os.Exit(cli.Main(version, os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
