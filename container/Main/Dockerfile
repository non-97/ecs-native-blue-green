FROM nginx:stable-alpine

# カスタムHTMLをコピー
COPY index.html /usr/share/nginx/html/

# Nginxのデフォルトポート
EXPOSE 80

# Nginxを起動
CMD ["nginx", "-g", "daemon off;"]
