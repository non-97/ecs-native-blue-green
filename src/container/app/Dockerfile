FROM node:24-alpine AS builder

# pnpmをインストール
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# package.jsonとpnpm-lock.yamlをコピー
COPY package.json pnpm-lock.yaml* ./

# 依存関係をインストール（devDependenciesも含む）
RUN pnpm install --frozen-lockfile

# ソースコードとtsconfig.jsonをコピー
COPY tsconfig.json ./
COPY src ./src

# TypeScriptをビルド
RUN pnpm build

# 本番用イメージ
FROM node:24-alpine

# pnpmとscriptをインストール
RUN corepack enable && corepack prepare pnpm@latest --activate && \
    apk add --no-cache util-linux

WORKDIR /app

# package.jsonをコピー
COPY package.json pnpm-lock.yaml* ./

# 本番用依存関係のみインストール
RUN pnpm install --prod --frozen-lockfile

# ビルド成果物をコピー
COPY --from=builder /app/dist ./dist

# 非rootユーザーで実行
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

CMD ["npm", "start"]
