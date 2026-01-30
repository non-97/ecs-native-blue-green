FROM node:24-alpine AS builder

# pnpmをインストール
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# package.jsonとpnpm-lock.yamlをコピー
COPY package.json pnpm-lock.yaml ./

# 依存関係をインストール（devDependencies含む、ビルドに必要）
RUN pnpm install --frozen-lockfile

# ソースコードとtsconfig.jsonをコピー
COPY tsconfig.json ./
COPY src ./src

# TypeScriptをビルド
RUN pnpm build

# 本番用イメージ
FROM node:24-alpine

# 非rootユーザーを作成
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# ビルダーから本番用node_modulesとビルド成果物をコピー
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --chown=nodejs:nodejs package.json ./

USER nodejs

EXPOSE 3000

# nodeで直接実行（シグナル処理のため）
CMD ["node", "dist/index.js"]
