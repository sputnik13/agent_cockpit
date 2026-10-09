//go:build !libghostty

package main

func expectedHandoffVerifierError() string { return "requires libghostty" }
