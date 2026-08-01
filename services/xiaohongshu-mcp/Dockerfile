# syntax=docker/dockerfile:1.7

FROM golang:1.24-bookworm AS builder

WORKDIR /src
ENV GOPROXY=https://proxy.golang.org,direct

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go test ./... \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
      -ldflags="-s -w -X main.version=v2.2.6-agent-workbench.5" \
      -o /out/app .

FROM xpzouying/xiaohongshu-mcp@sha256:9dd7a45d87dc6e209f0aaa53986e0d7b34ab837b49d767452adf42edc153bd2a

COPY --from=builder /out/app /app/app
