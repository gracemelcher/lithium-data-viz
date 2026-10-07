#!/usr/bin/env python3
"""Remove specified columns from a CSV file."""

import argparse
import csv


def main():
    parser = argparse.ArgumentParser(description="Drop columns from a CSV.")
    parser.add_argument("input_csv", help="Path to the CSV file to edit.")
    parser.add_argument("output_csv", help="Path to write the resulting CSV to.")
    parser.add_argument("columns", nargs="+", help="Names of columns to remove.")
    args = parser.parse_args()

    with open(args.input_csv, newline="") as infile:
        reader = csv.DictReader(infile)
        fieldnames = [f for f in reader.fieldnames if f not in args.columns]
        rows = [{k: row[k] for k in fieldnames} for row in reader]

    with open(args.output_csv, "w", newline="") as outfile:
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
