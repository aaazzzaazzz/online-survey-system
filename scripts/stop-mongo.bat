@echo off
rem 停止本地 MongoDB（127.0.0.1:27017 上的实例）
mongosh --quiet --eval "db.adminCommand({shutdown:1})" "mongodb://127.0.0.1:27017/admin"
