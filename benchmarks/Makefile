torch-client-bench:
	node index.js --relay --torch client --torchFile ./flame.raw --torchTime 10 \
		-- --relay --skipPing -s 4096,16384 -p 1000,10000,20000

torch-server-bench:
	node index.js --relay --torch server --torchFile ./flame.raw --torchTime 10 \
		-- --relay --skipPing -s 4096,16384 -p 1000,10000,20000

torch-relay-bench:
	node index.js --relay --torch relay --torchFile ./flame.raw --torchTime 10 \
		-- --relay --skipPing -s 4096,16384 -p 1000,10000,20000

flame-torch-relay-bench:
	node index.js --relay --torch relay --torchFile ./flame.html --torchTime 10 --torchType flame \
		-- --relay --skipPing -s 4096,16384 -p 1000,10000,20000

# torch-trace-bench:
# 	node index.js --trace --relay --torch server --torchFile ./flame.raw \
# 		-- --skipPing -s 4096

create-flame:
	stackcollapse-stap.pl ./flame.raw > ./flame.folded
	flamegraph.pl ./flame.folded > ./flame.svg
	google-chrome ./flame.svg

kill-dead-benchmarks:
	ps aux | pkill -f nodejs-benchmarks;

top-benchmark:
	top -d1 -cp `pgrep -f nodejs-benchmarks | tr "\\n" "," | sed 's/,$$//'`;

.PHONY: kill-dead-benchmarks top-benchmark